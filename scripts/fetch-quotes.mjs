#!/usr/bin/env node
// Fetches delayed quotes for every symbol in data/universe.json from Yahoo
// Finance and writes data/quotes.json. Runs in GitHub Actions on a schedule;
// the site is a static page that just reads the JSON.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
// Keep the UA minimal: a full fake-Chrome UA string trips Yahoo's bot
// detection (real Chrome sends sec-ch-ua headers alongside it) and gets 429s.
const UA = "Mozilla/5.0";
const BATCH = 150;

// Yahoo's quote API requires a session cookie + crumb.
async function getSession() {
  const res = await fetch("https://fc.yahoo.com/", {
    headers: { "User-Agent": UA },
    redirect: "manual",
  });
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  if (!cookie) throw new Error("no session cookie from fc.yahoo.com");
  const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": UA, Cookie: cookie },
  });
  const crumb = (await crumbRes.text()).trim();
  if (!crumbRes.ok || !crumb || crumb.includes("{")) {
    throw new Error(`bad crumb response: ${crumbRes.status} ${crumb.slice(0, 80)}`);
  }
  return { cookie, crumb };
}

async function fetchBatch(symbols, { cookie, crumb }) {
  const url =
    "https://query1.finance.yahoo.com/v7/finance/quote" +
    `?symbols=${symbols.join(",")}` +
    "&fields=symbol,longName,shortName,regularMarketPrice,regularMarketChangePercent,marketCap,netAssets,quoteType" +
    `&crumb=${encodeURIComponent(crumb)}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Cookie: cookie } });
  if (!res.ok) throw new Error(`quote batch -> HTTP ${res.status}`);
  const json = await res.json();
  if (json.quoteResponse?.error) throw new Error(JSON.stringify(json.quoteResponse.error));
  return json.quoteResponse?.result ?? [];
}

async function withRetry(fn, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries - 1) throw e;
      const wait = 5000 * 2 ** i;
      console.warn(`${e.message} — retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

const universe = JSON.parse(await readFile(path.join(DATA, "universe.json"), "utf8"));
const symbols = Object.keys(universe);
const session = await withRetry(getSession);

const quotes = {};
for (let i = 0; i < symbols.length; i += BATCH) {
  const batch = symbols.slice(i, i + BATCH);
  const result = await withRetry(() => fetchBatch(batch, session), 3);
  for (const q of result) {
    const meta = universe[q.symbol] || {};
    const price = q.regularMarketPrice;
    if (price == null) continue;
    quotes[q.symbol] = {
      p: price,
      c: round(q.regularMarketChangePercent ?? 0, 2),
      // ETFs have no market cap; net assets plays the same sizing role.
      mc: q.marketCap ?? q.netAssets ?? 0,
      n: meta.n || q.longName || q.shortName || q.symbol,
      s: meta.s || "Other",
      t: meta.t || "stock",
    };
  }
  await new Promise((r) => setTimeout(r, 500));
}

function round(x, d) {
  return Math.round(x * 10 ** d) / 10 ** d;
}

const missing = symbols.filter((s) => !quotes[s]);
if (missing.length) console.warn(`no quote for: ${missing.join(", ")}`);
if (Object.keys(quotes).length < symbols.length * 0.8) {
  throw new Error("fewer than 80% of symbols returned quotes; refusing to overwrite data");
}

await writeFile(
  path.join(DATA, "quotes.json"),
  JSON.stringify({ updated: Date.now(), quotes })
);
console.log(`wrote ${Object.keys(quotes).length}/${symbols.length} quotes`);
