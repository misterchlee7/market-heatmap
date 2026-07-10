#!/usr/bin/env node
// Builds the ticker universe (data/universe.json) and crypto symbol map
// (data/crypto-map.json). Run occasionally — constituents and coin ranks
// change slowly. The quote refresher (fetch-quotes.mjs) runs on its own
// schedule and only reads these files.

import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const UA = { "User-Agent": "Mozilla/5.0 (market-heatmap; github-pages hobby project)" };

const SP500_CSV =
  "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";

async function fetchText(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

async function fetchJSON(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

// Minimal CSV parser that handles quoted fields.
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field.trim()); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field || row.length) { row.push(field.trim()); rows.push(row); }
  return rows;
}

// Yahoo's sector names -> GICS names used by the S&P dataset, so grouping
// doesn't split into near-duplicate sectors.
const SECTOR_ALIAS = {
  Technology: "Information Technology",
  Healthcare: "Health Care",
  "Consumer Cyclical": "Consumer Discretionary",
  "Consumer Defensive": "Consumer Staples",
  "Financial Services": "Financials",
  "Basic Materials": "Materials",
};

async function buildStockUniverse() {
  const rows = parseCSV(await fetchText(SP500_CSV));
  const header = rows[0];
  const iSym = header.indexOf("Symbol");
  const iName = header.indexOf("Security");
  const iSector = header.indexOf("GICS Sector");
  const universe = {};
  for (const r of rows.slice(1)) {
    if (!r[iSym]) continue;
    const sym = r[iSym].replace(/\./g, "-"); // BRK.B -> BRK-B (Yahoo style)
    universe[sym] = { n: r[iName], s: r[iSector], t: "stock" };
  }

  // Popular tickers beyond the S&P 500. Sector is resolved from Yahoo's
  // keyless search endpoint below; ETFs get their own group.
  const extras = JSON.parse(await readFile(path.join(DATA, "extra-tickers.json"), "utf8"));
  for (const sym of extras.etfs) universe[sym] ??= { n: sym, s: "ETFs", t: "etf" };
  const missing = extras.stocks.filter((s) => !universe[s]);
  for (const sym of missing) {
    try {
      const j = await fetchJSON(
        `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(sym)}&quotesCount=5&newsCount=0`
      );
      const q = (j.quotes || []).find((x) => x.symbol === sym);
      const rawSector = q?.sectorDisp || q?.sector || "Other";
      universe[sym] = {
        n: q?.longname || q?.shortname || sym,
        s: SECTOR_ALIAS[rawSector] || rawSector,
        t: q?.quoteType === "ETF" ? "etf" : "stock",
      };
      if (universe[sym].t === "etf") universe[sym].s = "ETFs";
    } catch (e) {
      console.warn(`search failed for ${sym}: ${e.message}`);
      universe[sym] = { n: sym, s: "Other", t: "stock" };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  // Resolve ETF names too (search gives the fund's long name).
  for (const sym of extras.etfs) {
    if (universe[sym].n !== sym) continue;
    try {
      const j = await fetchJSON(
        `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(sym)}&quotesCount=5&newsCount=0`
      );
      const q = (j.quotes || []).find((x) => x.symbol === sym);
      if (q) universe[sym].n = q.longname || q.shortname || sym;
    } catch { /* name stays as symbol */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return universe;
}

async function buildCryptoMap() {
  const map = {};
  for (const page of [1, 2]) {
    const coins = await fetchJSON(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}`
    );
    for (const c of coins) {
      const sym = c.symbol.toUpperCase();
      // Symbol collisions: keep the higher-ranked (larger) coin.
      if (!map[sym]) map[sym] = { id: c.id, n: c.name };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return map;
}

const [universe, cryptoMap] = [await buildStockUniverse(), await buildCryptoMap()];
await writeFile(path.join(DATA, "universe.json"), JSON.stringify(universe));
await writeFile(path.join(DATA, "crypto-map.json"), JSON.stringify(cryptoMap));
console.log(
  `universe: ${Object.keys(universe).length} symbols, crypto map: ${Object.keys(cryptoMap).length} coins`
);
