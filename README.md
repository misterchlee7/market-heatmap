# Market Heatmap

A [finviz](https://finviz.com/map)-style treemap heatmap for **your own watchlist**
of stocks and crypto, hosted free on GitHub Pages. Tiles are sized by market cap
and colored by daily % change; groups follow GICS sectors (crypto gets its own
group).

## How it works

- **Static site** (`index.html`, `js/app.js`, `css/style.css`) — no framework,
  no build step, no API keys.
- **Stock quotes** — a GitHub Actions workflow
  ([.github/workflows/refresh.yml](.github/workflows/refresh.yml)) fetches
  delayed quotes for a ~630-symbol universe (S&P 500 + popular extras + ETFs)
  from Yahoo Finance every 15 minutes during US market hours and redeploys the
  site with a fresh `data/quotes.json`.
- **Crypto** — fetched live in the browser from the free
  [CoinGecko](https://www.coingecko.com) API (top 500 coins bundled; anything
  else resolves via CoinGecko search).
- **Your watchlist** lives in your browser (localStorage). Use **Share** to copy
  a URL that encodes the list (`?t=AAPL,NVDA,BTC.X`).

## Usage

- Type a symbol in the **Add** box (autocomplete included). `BTC` adds Bitcoin;
  use the `.X` suffix (`BTC.X`) to force crypto when a stock shares the symbol.
- **Edit list** opens the watchlist panel: remove chips, bulk-paste a list,
  reset, or clear.
- **Size** toggles market-cap vs equal sizing; **Group** toggles sector grouping.
- Click a tile to open it on finviz / CoinGecko.

### Adding a stock that shows "no data"

Quotes only exist for symbols in the tracked universe. Add your symbol to
[`data/extra-tickers.json`](data/extra-tickers.json) (stocks or ETFs), commit,
and it will have data within 15 minutes. The universe itself (S&P 500
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
