/* Market Heatmap — finviz-style treemap for a personal stock + crypto watchlist.
 * Stock quotes come from data/quotes.json (refreshed by GitHub Actions);
 * crypto is fetched live from CoinGecko in the browser. */
"use strict";

// Set after the repo exists; used for the "add a missing ticker" edit link.
const REPO_URL = "https://github.com/misterchlee7/market-heatmap";

// Cloudflare Worker that serves fresh quotes (see worker/). Refreshed hourly by
// the Worker's cron trigger — reliable and decoupled from Pages deploys. Paste
// the deployed worker URL here; empty string falls back to the bundled
// data/quotes.json (last snapshot committed by GitHub Actions).
const QUOTES_URL = "https://market-heatmap-quotes.heatmapmarket.workers.dev/";

const DEFAULT_LIST = [
  "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "AVGO", "BRK-B",
  "JPM", "V", "LLY", "UNH", "XOM", "COST", "NFLX", "AMD", "PLTR", "COIN",
  "BTC.X", "ETH.X", "SOL.X",
];
const LS_LIST = "heatmap.watchlist.v1";
const LS_PREFS = "heatmap.prefs.v1";
const LS_CRYPTO_CACHE = "heatmap.cryptocache.v1";
const LS_CUSTOM_COINS = "heatmap.customcoins.v1";
const LS_CRYPTO_HIST = "heatmap.cryptohist.v1";
const CRYPTO_REFRESH_MS = 60_000;
const CRYPTO_HIST_TTL_MS = 6 * 3600_000;

// Finviz-style diverging scale at ±bound %: red -> neutral gray -> green.
const COLOR_STOPS = [
  [-1, [246, 53, 56]],
  [-0.5, [191, 64, 69]],
  [0, [65, 69, 84]],
  [0.5, [53, 118, 78]],
  [1, [48, 204, 90]],
];

// Longer periods swing more, so each gets its own color saturation bound.
const PERIODS = {
  d1: { label: "1D", cryptoLabel: "24h", bound: 3 },
  w1: { label: "1W", bound: 7 },
  m1: { label: "1M", bound: 10 },
  m3: { label: "3M", bound: 15 },
  m6: { label: "6M", bound: 25 },
  ytd: { label: "YTD", bound: 30 },
  y1: { label: "1Y", bound: 40 },
  y5: { label: "5Y", bound: 150 },
};

const $ = (id) => document.getElementById(id);
const mapEl = $("map"), tooltipEl = $("tooltip");

const state = {
  list: [],          // [{sym, kind: "s"|"c"}]
  quotes: {},        // stock quotes from data/quotes.json
  quotesUpdated: 0,
  universe: {},      // stock metadata (name, sector, type)
  cryptoMap: {},     // SYMBOL -> {id, n}
  crypto: {},        // SYMBOL -> live coin data
  customCoins: JSON.parse(localStorage.getItem(LS_CUSTOM_COINS) || "{}"),
  stockRefs: {},     // SYM -> {w1, m1, ...} reference prices from data/refs.json
  cryptoHist: JSON.parse(localStorage.getItem(LS_CRYPTO_HIST) || "{}"), // SYM -> {t, refs}
  sizeBy: "sqrt",
  groupBy: "sector",
  period: "d1",
  cryptoError: false,
};

/* ---------------- watchlist persistence ---------------- */

function keyOf(it) { return it.kind === "c" ? it.sym + ".X" : it.sym; }

function loadList() {
  const fromUrl = new URLSearchParams(location.search).get("t");
  const raw = fromUrl
    ? fromUrl.split(",")
    : JSON.parse(localStorage.getItem(LS_LIST) || "null") ?? DEFAULT_LIST;
  state.list = [];
  for (const tok of raw) {
    const it = parseToken(String(tok));
    if (it && !state.list.some((x) => x.sym === it.sym && x.kind === it.kind)) {
      state.list.push(it);
    }
  }
  saveList(); // also syncs the address bar
}

// Persists the list and mirrors it into the URL, so the address bar is always
// a shareable / bookmarkable snapshot of the current watchlist.
function saveList() {
  localStorage.setItem(LS_LIST, JSON.stringify(state.list.map(keyOf)));
  const url = state.list.length
    ? `${location.pathname}?t=${state.list.map(keyOf).join(",")}`
    : location.pathname;
  history.replaceState(null, "", url);
}

function savePrefs() {
  localStorage.setItem(LS_PREFS, JSON.stringify({
    sizeBy: state.sizeBy, groupBy: state.groupBy, period: state.period,
  }));
}

function loadPrefs() {
  const p = JSON.parse(localStorage.getItem(LS_PREFS) || "{}");
  if (p.sizeBy) state.sizeBy = p.sizeBy;
  if (p.groupBy) state.groupBy = p.groupBy;
  if (PERIODS[p.period]) state.period = p.period;
  $("size-by").value = state.sizeBy;
  $("group-by").value = state.groupBy;
  $("period").value = state.period;
}

// "AAPL" -> stock; "BTC" -> crypto if it isn't a known stock; "BTC.X",
// "$BTC", "BTC-USD" -> force crypto. Returns null only for empty input.
function parseToken(tok) {
  let s = tok.trim().toUpperCase();
  if (!s) return null;
  let forceCrypto = false;
  if (s.startsWith("$") || s.startsWith("C:")) { forceCrypto = true; s = s.replace(/^\$|^C:/, ""); }
  if (s.endsWith(".X")) { forceCrypto = true; s = s.slice(0, -2); }
  if (s.endsWith("-USD")) { forceCrypto = true; s = s.slice(0, -4); }
  if (!forceCrypto && state.universe[s]) return { sym: s, kind: "s" };
  if (state.cryptoMap[s] || state.customCoins[s]) return { sym: s, kind: "c" };
  return { sym: s, kind: forceCrypto ? "c" : "s" }; // unknown: try as typed
}

/* ---------------- data loading ---------------- */

async function loadStatic() {
  const [quotes, universe, cryptoMap, refs] = await Promise.all([
    loadQuotes(),
    fetch("data/universe.json").then((r) => r.json()),
    fetch("data/crypto-map.json").then((r) => r.json()),
    loadRefs(),
  ]);
  state.quotes = quotes.quotes;
  state.quotesUpdated = quotes.updated;
  state.universe = universe;
  state.cryptoMap = cryptoMap;
  state.stockRefs = refs.refs;
}

// Prefer the live Worker feed; fall back to the bundled snapshot if the Worker
// is unset or unreachable so the site never renders empty. `key` is the field
// the Worker payload must contain ("quotes"/"refs"); `fallback` is the bundled
// JSON path.
async function loadFromWorker(path, key, fallback) {
  if (QUOTES_URL) {
    try {
      const r = await fetch(QUOTES_URL.replace(/\/$/, "") + path);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j[key]) return j;
      throw new Error(`no ${key} in worker response`);
    } catch (e) {
      console.warn(`worker ${key} unavailable (${e.message}); using bundled snapshot`);
    }
  }
  return fetch(fallback).then((r) => r.json());
}

const loadQuotes = () => loadFromWorker("/", "quotes", "data/quotes.json");
const loadRefs = () =>
  loadFromWorker("/refs", "refs", "data/refs.json").catch(() => ({ refs: {} }));

function coinIdFor(sym) {
  return state.cryptoMap[sym]?.id || state.customCoins[sym]?.id || null;
}

async function refreshCrypto() {
  const wanted = state.list.filter((it) => it.kind === "c");
  if (!wanted.length) return;

  // Resolve symbols not in the bundled top-500 map via CoinGecko search.
  for (const it of wanted) {
    if (coinIdFor(it.sym)) continue;
    try {
      const j = await (await fetch(
        `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(it.sym)}`
      )).json();
      const hit = (j.coins || []).find((c) => c.symbol.toUpperCase() === it.sym);
      if (hit) {
        state.customCoins[it.sym] = { id: hit.id, n: hit.name };
        localStorage.setItem(LS_CUSTOM_COINS, JSON.stringify(state.customCoins));
      }
    } catch { /* leave unresolved; tile shows no-data */ }
  }

  const ids = wanted.map((it) => coinIdFor(it.sym)).filter(Boolean);
  if (!ids.length) return;
  try {
    const rows = await (await fetch(
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=" +
      ids.join(",") + "&price_change_percentage=24h&per_page=250"
    )).json();
    if (!Array.isArray(rows)) throw new Error("rate limited");
    for (const c of rows) {
      state.crypto[c.symbol.toUpperCase()] = {
        p: c.current_price,
        c: c.price_change_percentage_24h ?? 0,
        mc: c.market_cap || 0,
        n: c.name,
      };
    }
    state.cryptoError = false;
    localStorage.setItem(LS_CRYPTO_CACHE, JSON.stringify(state.crypto));
  } catch {
    // Rate limit or offline: fall back to the last successful fetch.
    if (!Object.keys(state.crypto).length) {
      state.crypto = JSON.parse(localStorage.getItem(LS_CRYPTO_CACHE) || "{}");
    }
    state.cryptoError = true;
  }
  render();
}

/* ---------------- item resolution ---------------- */

// Change % for the selected period, or null when honest data isn't available
// (IPO younger than the period, crypto history beyond CoinGecko's free year).
function periodChange(price, chg1d, refs) {
  if (state.period === "d1") return chg1d;
  const ref = refs?.[state.period];
  return ref ? (price / ref - 1) * 100 : null;
}

function resolveItem(it) {
  if (it.kind === "s") {
    const q = state.quotes[it.sym];
    const meta = state.universe[it.sym];
    if (!q) return { ...it, name: meta?.n || it.sym, sector: meta?.s || "Other", nodata: true };
    return {
      ...it, name: q.n, sector: q.s, price: q.p, mc: q.mc, chg1d: q.c,
      chg: periodChange(q.p, q.c, state.stockRefs[it.sym]),
    };
  }
  const d = state.crypto[it.sym];
  const name = d?.n || state.cryptoMap[it.sym]?.n || state.customCoins[it.sym]?.n || it.sym;
  if (!d) return { ...it, name, sector: "Crypto", nodata: true };
  return {
    ...it, name, sector: "Crypto", price: d.p, mc: d.mc, chg1d: d.c,
    chg: periodChange(d.p, d.c, state.cryptoHist[it.sym]?.refs),
  };
}

/* ---------------- crypto history (for non-1D periods) ---------------- */

function periodTargets(nowMs) {
  const shift = (fn) => { const d = new Date(nowMs); fn(d); return d.getTime(); };
  return {
    w1: nowMs - 7 * 864e5,
    m1: shift((d) => d.setMonth(d.getMonth() - 1)),
    m3: shift((d) => d.setMonth(d.getMonth() - 3)),
    m6: shift((d) => d.setMonth(d.getMonth() - 6)),
    ytd: new Date(new Date(nowMs).getFullYear(), 0, 1).getTime(),
    y1: shift((d) => d.setFullYear(d.getFullYear() - 1)),
    // No y5: CoinGecko's free tier only serves 365 days of history.
  };
}

function refAt(points, target) {
  let best = null;
  for (const [ts, px] of points) {
    if (ts <= target) best = px; else break;
  }
  if (best == null && points.length && points[0][0] - target < 4 * 864e5) best = points[0][1];
  return best;
}

// Fetch a year of daily prices per watchlist coin (cached 6h) so crypto tiles
// have real 1W/1M/3M/6M/YTD/1Y numbers. Runs only when such a period is shown.
let cryptoHistBusy = false;
async function ensureCryptoHist() {
  if (state.period === "d1" || cryptoHistBusy) return;
  const now = Date.now();
  const need = state.list.filter((it) =>
    it.kind === "c" && coinIdFor(it.sym) &&
    !(state.cryptoHist[it.sym] && now - state.cryptoHist[it.sym].t < CRYPTO_HIST_TTL_MS));
  if (!need.length) return;
  cryptoHistBusy = true;
  let changed = false;
  for (const it of need) {
    try {
      const j = await (await fetch(
        `https://api.coingecko.com/api/v3/coins/${coinIdFor(it.sym)}/market_chart?vs_currency=usd&days=365`
      )).json();
      if (!Array.isArray(j.prices)) throw new Error("rate limited");
      const refs = {};
      for (const [key, target] of Object.entries(periodTargets(now))) {
        const v = refAt(j.prices, target);
        if (v != null) refs[key] = v;
      }
      state.cryptoHist[it.sym] = { t: now, refs };
      changed = true;
      await new Promise((r) => setTimeout(r, 500));
    } catch { break; /* rate limited: retry on next refresh cycle */ }
  }
  cryptoHistBusy = false;
  if (changed) {
    localStorage.setItem(LS_CRYPTO_HIST, JSON.stringify(state.cryptoHist));
    render();
  }
}

/* ---------------- squarified treemap ---------------- */

function worstAspect(row, sum, side) {
  const s2 = sum * sum, d2 = side * side;
  let mx = 0;
  for (const a of row) mx = Math.max(mx, (d2 * a) / s2, s2 / (d2 * a));
  return mx;
}

// items: [{value,...}] sorted desc. Returns rects [{x,y,w,h,item}].
function squarify(items, x, y, w, h) {
  const out = [];
  const total = items.reduce((s, it) => s + it.value, 0);
  if (total <= 0 || w <= 4 || h <= 4) {
    // Degenerate space: stack evenly so every item still gets a rect.
    items.forEach((item, i) =>
      out.push({ x, y: y + (h / items.length) * i, w, h: h / items.length, item }));
    return out;
  }
  const scale = (w * h) / total;
  const areas = items.map((it) => Math.max(it.value * scale, 0.0001));
  let i = 0, cx = x, cy = y, cw = w, ch = h;
  while (i < areas.length) {
    const side = Math.min(cw, ch);
    let row = [areas[i]], sum = areas[i], best = worstAspect(row, sum, side);
    let j = i + 1;
    while (j < areas.length) {
      const cand = worstAspect([...row, areas[j]], sum + areas[j], side);
      if (cand > best) break;
      row.push(areas[j]); sum += areas[j]; best = cand; j++;
    }
    const thick = sum / side;
    let off = 0;
    for (let k = 0; k < row.length; k++) {
      const len = row[k] / thick;
      out.push(cw >= ch
        ? { x: cx, y: cy + off, w: thick, h: len, item: items[i + k] }
        : { x: cx + off, y: cy, w: len, h: thick, item: items[i + k] });
      off += len;
    }
    if (cw >= ch) { cx += thick; cw -= thick; } else { cy += thick; ch -= thick; }
    i += row.length;
  }
  return out;
}

/* ---------------- rendering ---------------- */

const NEUTRAL = "rgb(65,69,84)";

function colorFor(chg) {
  if (chg == null) return "#2e3240";
  const v = Math.max(-1, Math.min(1, chg / PERIODS[state.period].bound));
  for (let i = 0; i < COLOR_STOPS.length - 1; i++) {
    const [v0, c0] = COLOR_STOPS[i], [v1, c1] = COLOR_STOPS[i + 1];
    if (v <= v1) {
      const t = (v - v0) / (v1 - v0);
      const mix = c0.map((a, k) => Math.round(a + (c1[k] - a) * t));
      return `rgb(${mix.join(",")})`;
    }
  }
  return NEUTRAL;
}

function fmtChg(chg) {
  if (chg == null) return "–";
  const a = Math.abs(chg);
  const dec = a >= 100 ? 0 : a >= 10 ? 1 : 2;
  return (chg >= 0 ? "+" : "") + chg.toFixed(dec) + "%";
}

function fmtPrice(p) {
  if (p == null) return "—";
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (p >= 1) return p.toFixed(2);
  return p.toPrecision(3);
}

function fmtCap(mc) {
  if (!mc) return "—";
  const units = [[1e12, "T"], [1e9, "B"], [1e6, "M"]];
  for (const [u, s] of units) if (mc >= u) return "$" + (mc / u).toFixed(2) + s;
  return "$" + Math.round(mc).toLocaleString();
}

function render() {
  const items = state.list.map(resolveItem);
  mapEl.textContent = "";
  $("empty-hint").hidden = items.length > 0;
  renderChips(items);
  renderStatus();
  updateMissingHint(items);
  if (!items.length) return;

  const W = mapEl.clientWidth, H = mapEl.clientHeight;
  let values = items.map((it) =>
    state.sizeBy === "eq" ? 1
    : state.sizeBy === "sqrt" ? Math.sqrt(it.mc || 0)
    : it.mc || 0);
  // Guarantee every tile a readable minimum area (enough for its ticker
  // label), whatever the size mode says. Iterate because raising small
  // values grows the total, which shrinks everyone's share slightly.
  const minArea = Math.min(2400, (W * H) / items.length / 2);
  for (let pass = 0; pass < 3; pass++) {
    const total = values.reduce((a, b) => a + b, 0) || 1;
    const floorV = total * (minArea / (W * H));
    values = values.map((v) => Math.max(v, floorV));
  }
  items.forEach((it, i) => { it.value = values[i]; });

  let tiles = [];
  if (state.groupBy === "sector" && items.length > 1) {
    const bySector = new Map();
    for (const it of items) {
      if (!bySector.has(it.sector)) bySector.set(it.sector, []);
      bySector.get(it.sector).push(it);
    }
    const groups = [...bySector.entries()].map(([name, members]) => ({
      name,
      members: members.sort((a, b) => b.value - a.value),
      value: members.reduce((s, m) => s + m.value, 0),
    })).sort((a, b) => b.value - a.value);

    for (const g of squarify(groups, 0, 0, W, H)) {
      const HEADER = g.w > 70 && g.h > 46 ? 15 : 0;
      if (HEADER) {
        const lbl = document.createElement("div");
        lbl.className = "group-label";
        lbl.textContent = g.item.name;
        Object.assign(lbl.style, {
          left: g.x + 1 + "px", top: g.y + 1 + "px",
          width: g.w - 2 + "px", height: HEADER + "px",
        });
        mapEl.appendChild(lbl);
      }
      tiles.push(...squarify(g.item.members, g.x, g.y + HEADER, g.w, g.h - HEADER));
    }
  } else {
    tiles = squarify(items.slice().sort((a, b) => b.value - a.value), 0, 0, W, H);
  }

  for (const t of tiles) mapEl.appendChild(makeTile(t));
}

function makeTile({ x, y, w, h, item }) {
  const el = document.createElement("div");
  el.className = "tile" + (item.nodata ? " nodata" : "");
  Object.assign(el.style, {
    left: x + "px", top: y + "px",
    width: Math.max(w, 1) + "px", height: Math.max(h, 1) + "px",
  });
  if (!item.nodata) el.style.background = colorFor(item.chg);

  const fs = Math.max(9, Math.min(w / (item.sym.length * 0.72), h * 0.34, 30));
  if (w > 26 && h > 15) {
    const sym = document.createElement("div");
    sym.className = "sym";
    sym.style.fontSize = fs + "px";
    sym.textContent = item.sym;
    el.appendChild(sym);
    if (!item.nodata && h > fs * 2.1 && w > 40) {
      const chg = document.createElement("div");
      chg.className = "chg";
      chg.style.fontSize = Math.max(8.5, fs * 0.58) + "px";
      chg.textContent = fmtChg(item.chg);
      el.appendChild(chg);
    }
  }

  el.addEventListener("mousemove", (e) => showTooltip(e, item));
  el.addEventListener("mouseleave", hideTooltip);
  el.addEventListener("click", () => {
    const url = item.kind === "c"
      ? `https://www.coingecko.com/en/coins/${coinIdFor(item.sym) || ""}`
      : `https://finviz.com/quote.ashx?t=${encodeURIComponent(item.sym)}`;
    window.open(url, "_blank", "noopener");
  });
  return el;
}

function showTooltip(e, item) {
  const P = PERIODS[state.period];
  const label = (item.kind === "c" && P.cryptoLabel) || P.label;
  const extra1d = state.period !== "d1"
    ? `<div class="tt-row"><span>${item.kind === "c" ? "24h" : "1D"}</span><b>${fmtChg(item.chg1d)}</b></div>`
    : "";
  const rows = item.nodata
    ? `<div class="tt-row"><span>No data yet</span></div>`
    : `<div class="tt-row"><span>Price</span><b>$${fmtPrice(item.price)}</b></div>
       <div class="tt-row"><span>${label}</span><b>${item.chg == null ? "no data this far back" : fmtChg(item.chg)}</b></div>${extra1d}
       <div class="tt-row"><span>${item.kind === "c" ? "Mkt cap" : state.universe[item.sym]?.t === "etf" ? "Net assets" : "Mkt cap"}</span><b>${fmtCap(item.mc)}</b></div>`;
  tooltipEl.innerHTML =
    `<div class="tt-name">${item.sym} · ${escapeHtml(item.name)}</div>
     <div class="tt-row"><span>${escapeHtml(item.sector)}</span></div>${rows}`;
  tooltipEl.hidden = false;
  const pad = 14, tw = tooltipEl.offsetWidth, th = tooltipEl.offsetHeight;
  tooltipEl.style.left = Math.min(e.clientX + pad, innerWidth - tw - 8) + "px";
  tooltipEl.style.top = (e.clientY + pad + th > innerHeight ? e.clientY - th - 8 : e.clientY + pad) + "px";
}
function hideTooltip() { tooltipEl.hidden = true; }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/* ---------------- chrome: status, chips, hints ---------------- */

function renderStatus() {
  const ts = state.quotesUpdated
    ? new Date(state.quotesUpdated).toLocaleString("en-US", {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
        timeZone: "America/New_York",
      }) + " ET"
    : "…";
  const cryptoNote = state.cryptoError ? " · crypto rate-limited (cached)" : "";
  $("status").textContent = `Stocks as of ${ts} · Crypto live${cryptoNote}`;
}

function renderChips(items) {
  const box = $("chips");
  box.textContent = "";
  for (const it of items) {
    const chip = document.createElement("span");
    chip.className = "chip" + (it.kind === "c" ? " crypto" : "");
    chip.innerHTML =
      `<span>${it.sym}</span><span class="kind">${it.kind === "c" ? "crypto" : "stock"}</span>`;
    const rm = document.createElement("button");
    rm.textContent = "×";
    rm.title = `Remove ${it.sym}`;
    rm.addEventListener("click", () => {
      state.list = state.list.filter((x) => !(x.sym === it.sym && x.kind === it.kind));
      saveList();
      render();
    });
    chip.appendChild(rm);
    box.appendChild(chip);
  }
  $("bulk-text").value = state.list.map(keyOf).join("\n");
}

function updateMissingHint(items) {
  const missingStocks = items.filter((it) => it.nodata && it.kind === "s");
  const hint = $("missing-hint");
  hint.hidden = !missingStocks.length;
  if (missingStocks.length) {
    hint.innerHTML =
      `No data for <b>${missingStocks.map((m) => m.sym).join(", ")}</b>. ` +
      `If it's a real stock ticker, add it to ` +
      `<a href="${REPO_URL}/edit/main/data/extra-tickers.json" target="_blank" rel="noopener">extra-tickers.json</a> ` +
      `and data appears on the next 15-minute refresh. For crypto, use the .X suffix (e.g. ${missingStocks[0].sym}.X).`;
  }
}

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ---------------- inputs & events ---------------- */

function addToken(tok) {
  const it = parseToken(tok);
  if (!it) return false;
  if (state.list.some((x) => x.sym === it.sym && x.kind === it.kind)) {
    toast(`${it.sym} is already on the list`);
    return false;
  }
  state.list.push(it);
  return true;
}

function buildDatalist() {
  const dl = $("symbol-list");
  const frag = document.createDocumentFragment();
  for (const [sym, m] of Object.entries(state.universe)) {
    const o = document.createElement("option");
    o.value = sym;
    o.label = `${m.n} (${m.t === "etf" ? "ETF" : "stock"})`;
    frag.appendChild(o);
  }
  for (const [sym, m] of Object.entries(state.cryptoMap)) {
    const o = document.createElement("option");
    o.value = sym + ".X";
    o.label = `${m.n} (crypto)`;
    frag.appendChild(o);
  }
  dl.appendChild(frag);
}

function wireEvents() {
  $("add-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const toks = $("add-input").value.split(/[,\s]+/).filter(Boolean);
    let added = 0;
    for (const tok of toks) added += addToken(tok) ? 1 : 0;
    if (added) {
      saveList();
      render();
      refreshCrypto();
      $("add-input").value = "";
    }
  });

  $("period").addEventListener("change", (e) => {
    state.period = e.target.value;
    savePrefs();
    render();
    ensureCryptoHist();
  });
  $("size-by").addEventListener("change", (e) => { state.sizeBy = e.target.value; savePrefs(); render(); });
  $("group-by").addEventListener("change", (e) => { state.groupBy = e.target.value; savePrefs(); render(); });

  $("edit-btn").addEventListener("click", () => { $("panel").hidden = !$("panel").hidden; });
  $("panel-close").addEventListener("click", () => { $("panel").hidden = true; });

  $("share-btn").addEventListener("click", async () => {
    const url = `${location.origin}${location.pathname}?t=${state.list.map(keyOf).join(",")}`;
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied — open it on another device to load this watchlist there");
    } catch {
      prompt("Copy this link:", url);
    }
  });

  const reset = () => {
    state.list = DEFAULT_LIST.map(parseToken);
    saveList();
    render();
    refreshCrypto();
  };
  $("reset-btn").addEventListener("click", reset);
  $("reset-inline").addEventListener("click", reset);
  $("clear-btn").addEventListener("click", () => {
    state.list = [];
    saveList();
    render();
  });

  $("bulk-apply").addEventListener("click", () => {
    state.list = [];
    for (const tok of $("bulk-text").value.split(/[,\s]+/).filter(Boolean)) addToken(tok);
    saveList();
    render();
    refreshCrypto();
    toast(`Watchlist set: ${state.list.length} symbols`);
  });

  let resizeTimer;
  addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 120);
  });
}

/* ---------------- boot ---------------- */

(async function main() {
  try {
    await loadStatic();
  } catch (e) {
    mapEl.innerHTML =
      `<p style="padding:30px;color:var(--text-dim)">Failed to load market data (${escapeHtml(e.message)}). Try reloading.</p>`;
    return;
  }
  loadList();
  loadPrefs();
  buildDatalist();
  wireEvents();
  render();
  refreshCrypto().then(ensureCryptoHist);
  setInterval(() => refreshCrypto().then(ensureCryptoHist), CRYPTO_REFRESH_MS);
})();
