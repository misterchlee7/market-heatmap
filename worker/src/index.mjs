/**
 * Cloudflare Worker for market-heatmap: serves fresh Yahoo Finance data as JSON.
 *
 *  Routes (all CORS-enabled, ?refresh=1 forces a rebuild):
 *    GET /            -> quotes.json  (delayed quotes for the whole universe)
 *    GET /refs        -> refs.json    (per-period reference close prices)
 *
 *  Crons (wrangler.toml):
 *    "0 13-21 * * 1-5"  -> quotes, hourly during US market hours
 *    "20 8 * * *"       -> refs, daily off-hours
 *
 * Data is cached in KV and pulled by the browser. The ticker universe is read
 * at runtime from the repo's raw GitHub URL (UNIVERSE_URL), so the weekly
 * universe rebuild stays in GitHub Actions with no Worker redeploy.
 *
 * Quotes port scripts/fetch-quotes.mjs; refs port scripts/fetch-history.mjs. The
 * one deviation from the Node script: history uses Yahoo's multi-symbol `spark`
 * endpoint (batched, ~32 requests) instead of one chart request per symbol,
 * because a Worker invocation is capped at 50 subrequests on the free plan.
 */

const KV_QUOTES = "quotes.json";
const KV_REFS = "refs.json";
// A full fake-Chrome UA trips Yahoo's bot detection (real Chrome sends sec-ch-ua
// headers alongside it) and gets 429s. Keep it minimal.
const UA = "Mozilla/5.0";
const QUOTE_BATCH = 150;
// The spark endpoint returns its symbol-keyed shape only up to ~20 symbols per
// request; above that it switches to an error wrapper. 630/20 ≈ 32 requests,
// safely under the free-plan 50-subrequest cap.
const SPARK_BATCH = 20;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

/* ---------------- shared helpers ---------------- */

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

function round(x, d) {
  return Math.round(x * 10 ** d) / 10 ** d;
}

async function loadUniverse(env) {
  return (await fetch(env.UNIVERSE_URL, { headers: { "User-Agent": UA } })).json();
}

/* ---------------- quotes ---------------- */

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

async function fetchQuoteBatch(symbols, { cookie, crumb }) {
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

async function buildQuotes(env) {
  const universe = await loadUniverse(env);
  const symbols = Object.keys(universe);
  const session = await withRetry(getSession);

  const quotes = {};
  for (let i = 0; i < symbols.length; i += QUOTE_BATCH) {
    const batch = symbols.slice(i, i + QUOTE_BATCH);
    const result = await withRetry(() => fetchQuoteBatch(batch, session), 3);
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

  const got = Object.keys(quotes).length;
  if (got < symbols.length * 0.8) {
    throw new Error(`only ${got}/${symbols.length} symbols returned; refusing to overwrite`);
  }
  return { updated: Date.now(), quotes };
}

/* ---------------- refs (period reference prices) ---------------- */

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

function refsFromSeries(rawTs, close, targets) {
  const ts = [], px = [];
  for (let i = 0; i < rawTs.length; i++) {
    if (close[i] != null) { ts.push(rawTs[i] * 1000); px.push(close[i]); }
  }
  if (!ts.length) return null;
  const refs = {};
  for (const [key, target] of Object.entries(targets)) {
    const v = refAt(ts, px, target);
    if (v != null) refs[key] = +v.toFixed(4);
  }
  return refs;
}

// Multi-symbol spark request. Returns { SYMBOL: {timestamp, close}, ... } for
// batches at/under SPARK_BATCH; throws on the error-wrapper shape so the caller
// can retry.
async function fetchSparkBatch(symbols) {
  const url =
    "https://query1.finance.yahoo.com/v8/finance/spark" +
    `?symbols=${symbols.map(encodeURIComponent).join(",")}&range=5y&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`spark batch -> HTTP ${res.status}`);
  const json = await res.json();
  if (json.spark) throw new Error("spark returned wrapped/error shape");
  return json;
}

async function buildRefs(env) {
  const universe = await loadUniverse(env);
  const symbols = Object.keys(universe);
  const targets = periodTargets(Date.now());
  const refs = {};

  for (let i = 0; i < symbols.length; i += SPARK_BATCH) {
    const batch = symbols.slice(i, i + SPARK_BATCH);
    let data;
    try {
      data = await withRetry(() => fetchSparkBatch(batch), 2);
    } catch (e) {
      console.warn(`spark batch @${i} failed: ${e.message}`);
      continue; // leave these symbols out; the 80% guard below still applies
    }
    for (const sym of batch) {
      const s = data[sym];
      if (!s?.timestamp || !s?.close) continue;
      const r = refsFromSeries(s.timestamp, s.close, targets);
      if (r) refs[sym] = r;
    }
    await new Promise((r) => setTimeout(r, 120));
  }

  const got = Object.keys(refs).length;
  if (got < symbols.length * 0.8) {
    throw new Error(`only ${got}/${symbols.length} symbols returned history; refusing to overwrite`);
  }
  return { updated: Date.now(), refs };
}

/* ---------------- KV + routing ---------------- */

async function refreshInto(env, kvKey, builder) {
  const payload = await builder(env);
  await env.QUOTES.put(kvKey, JSON.stringify(payload));
  const n = Object.keys(payload.quotes || payload.refs).length;
  console.log(`wrote ${n} entries to ${kvKey}`);
  return payload;
}

function serveJson(body, status = 200, cache = false) {
  return new Response(body, {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json",
      ...(cache ? { "Cache-Control": "public, max-age=60" } : {}),
    },
  });
}

async function handleData(env, url, kvKey, builder) {
  if (url.searchParams.get("refresh") === "1") {
    try {
      return serveJson(JSON.stringify(await refreshInto(env, kvKey, builder)));
    } catch (e) {
      return serveJson(JSON.stringify({ error: String(e.message || e) }), 502);
    }
  }
  let body = await env.QUOTES.get(kvKey);
  if (!body) {
    // First deploy before the first cron tick — populate lazily.
    try {
      body = JSON.stringify(await refreshInto(env, kvKey, builder));
    } catch (e) {
      return serveJson(JSON.stringify({ error: `no cache and refresh failed: ${e.message || e}` }), 502);
    }
  }
  return serveJson(body, 200, true);
}

export default {
  async scheduled(event, env, ctx) {
    // Daily cron builds refs; the market-hours crons build quotes.
    const builder = event.cron === "20 8 * * *"
      ? [KV_REFS, buildRefs]
      : [KV_QUOTES, buildQuotes];
    ctx.waitUntil(refreshInto(env, ...builder));
  },

  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === "/refs") return handleData(env, url, KV_REFS, buildRefs);
    return handleData(env, url, KV_QUOTES, buildQuotes);
  },
};
