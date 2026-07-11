#!/usr/bin/env node
// Fetches 5 years of daily closes per symbol from Yahoo's keyless chart API
// and stores one reference price per timeframe (1W/1M/3M/6M/YTD/1Y/5Y) in
// data/refs.json. The page computes period returns as current_price / ref - 1,
// so returns stay fresh with every 15-minute quote refresh while this script
// only needs to run daily.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const UA = "Mozilla/5.0"; // full fake-Chrome UA strings trip Yahoo's bot detection
const CONCURRENCY = 6;

function periodTargets(nowMs) {
  const shift = (fn) => { const d = new Date(nowMs); fn(d); return d.getTime(); };
  return {
    w1: nowMs - 7 * 864e5,
    m1: shift((d) => d.setMonth(d.getMonth() - 1)),
    m3: shift((d) => d.setMonth(d.getMonth() - 3)),
    m6: shift((d) => d.setMonth(d.getMonth() - 6)),
    ytd: new Date(new Date(nowMs).getFullYear(), 0, 1).getTime(),
    y1: shift((d) => d.setFullYear(d.getFullYear() - 1)),
    y5: shift((d) => d.setFullYear(d.getFullYear() - 5)),
  };
}

// Latest close at/before the target date; tolerate a series that starts up to
// 4 days after it (weekend/holiday boundary). Otherwise: no ref (e.g. an IPO
// younger than the timeframe) and the tile shows "–" for that period.
function refAt(ts, px, target) {
  let best = null;
  for (let i = 0; i < ts.length && ts[i] <= target; i++) best = px[i];
  if (best == null && ts.length && ts[0] - target < 4 * 864e5) best = px[0];
  return best;
}

async function fetchRefs(sym, targets) {
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5y&interval=1d`,
    { headers: { "User-Agent": UA } }
  );
  if (!res.ok) throw new Error(`${sym} -> HTTP ${res.status}`);
  const r = (await res.json()).chart?.result?.[0];
  const close = r?.indicators?.quote?.[0]?.close;
  if (!r?.timestamp || !close) throw new Error(`${sym}: empty chart`);
  const ts = [], px = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    if (close[i] != null) { ts.push(r.timestamp[i] * 1000); px.push(close[i]); }
  }
  const refs = {};
  for (const [key, target] of Object.entries(targets)) {
    const v = refAt(ts, px, target);
    if (v != null) refs[key] = +v.toFixed(4);
  }
  return refs;
}

const universe = JSON.parse(await readFile(path.join(DATA, "universe.json"), "utf8"));
const symbols = Object.keys(universe);
const targets = periodTargets(Date.now());
const refs = {};
const failed = [];

let cursor = 0;
async function worker() {
  while (cursor < symbols.length) {
    const sym = symbols[cursor++];
    for (let attempt = 0; ; attempt++) {
      try {
        refs[sym] = await fetchRefs(sym, targets);
        break;
      } catch (e) {
        if (attempt >= 1) { failed.push(sym); console.warn(e.message); break; }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    await new Promise((r) => setTimeout(r, 80));
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

if (failed.length) console.warn(`no history for: ${failed.join(", ")}`);
if (Object.keys(refs).length < symbols.length * 0.8) {
  throw new Error("fewer than 80% of symbols returned history; refusing to overwrite data");
}

await writeFile(path.join(DATA, "refs.json"), JSON.stringify({ updated: Date.now(), refs }));
console.log(`wrote refs for ${Object.keys(refs).length}/${symbols.length} symbols`);
