# Market Heatmap

A [finviz](https://finviz.com/map)-style treemap heatmap for **your own watchlist**
of stocks and crypto, hosted free on GitHub Pages. Tiles are sized by market cap
and colored by daily % change; groups follow GICS sectors (crypto gets its own
group).

## How it works

- **Static site** (`index.html`, `js/app.js`, `css/style.css`) — no framework,
  no build step, no API keys.
- **Stock quotes** — a [Cloudflare Worker](worker/) fetches delayed quotes for a
  ~630-symbol universe (S&P 500 + popular extras + ETFs) from Yahoo Finance on an
  hourly cron and serves them as JSON to the browser (set via `QUOTES_URL` in
  `js/app.js`). If the Worker is unset or unreachable the site falls back to a
  bundled `data/quotes.json` snapshot, refreshed daily by a GitHub Actions
  workflow ([.github/workflows/refresh.yml](.github/workflows/refresh.yml)) that
  also rebuilds the ticker universe and history reference prices.
- **Crypto** — fetched live in the browser from the free
  [CoinGecko](https://www.coingecko.com) API (top 500 coins bundled; anything
  else resolves via CoinGecko search).
- **Your watchlist** lives in your browser (localStorage) and is mirrored into
  the address bar (`?t=AAPL,NVDA,BTC.X`), so the current URL is always a
  shareable, bookmarkable snapshot. **Share** copies it; opening it on another
  device imports the list into that browser.

## Usage

- Type a symbol in the **Add** box (autocomplete included). `BTC` adds Bitcoin;
  use the `.X` suffix (`BTC.X`) to force crypto when a stock shares the symbol.
- **Edit list** opens the watchlist panel: remove chips, bulk-paste a list,
  reset, or clear.
- **Period** switches the % change shown: 1D, 1W, 1M, 3M, 6M, YTD, 1Y, 5Y.
  Stock returns are computed against daily-close reference prices refreshed
  nightly (`data/refs.json`, from Yahoo's chart API); crypto history comes from
  CoinGecko (free tier reaches back one year, so coins show "–" on 5Y — no
  made-up numbers). The color scale widens with the period (±3% at 1D, ±40% at
  1Y) so longer horizons don't saturate.
- **Size** modes: **Balanced** (default, area ∝ √market-cap so small positions
  stay readable), **Market cap** (finviz-style proportional), **Equal**. Every
  tile is guaranteed a readable minimum size in all modes. **Group** toggles
  sector grouping.
- Click a tile to open it on finviz / CoinGecko.

### Adding a stock that shows "no data"

Quotes only exist for symbols in the tracked universe. Add your symbol to
[`data/extra-tickers.json`](data/extra-tickers.json) (stocks or ETFs), commit,
and it will have data within the hour. The universe itself (S&P 500
constituents, coin rankings) rebuilds automatically every Sunday.

## Local development

```sh
python3 -m http.server 8642        # serve the site
node scripts/fetch-quotes.mjs      # refresh data/quotes.json
node scripts/build-universe.mjs    # rebuild universe + crypto map
```

## Disclaimers

Stock data is delayed and comes from unofficial Yahoo Finance endpoints; crypto
data from CoinGecko's free tier. For personal, non-commercial use. Not
investment advice.
