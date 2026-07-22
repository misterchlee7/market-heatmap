# Quotes Worker

A Cloudflare Worker that fetches Yahoo Finance data for the heatmap's ticker
universe and serves it as JSON to the site. Replaces the flaky GitHub Actions
`schedule` cron for intraday refresh.

Routes (CORS-enabled; `?refresh=1` forces a rebuild):

| Route   | Data        | Cron              | Notes                                    |
| ------- | ----------- | ----------------- | ---------------------------------------- |
| `GET /`     | `quotes.json` | `0 13-21 * * 1-5` | delayed quotes, hourly during US session |
| `GET /refs` | `refs.json`   | `20 8 * * *`      | per-period reference closes, daily       |

- `scheduled()` — the daily cron builds refs; the market-hours crons build
  quotes. Each writes to KV.
- `fetch()` — serves the cached JSON. Lazily populates KV on the first request
  if the cron hasn't run yet.

The ticker universe is pulled at runtime from the repo's raw GitHub URL
(`UNIVERSE_URL`), so the weekly universe rebuild stays in GitHub Actions. Refs
use Yahoo's multi-symbol `spark` endpoint (batched at 20 symbols/request, ~32
requests) to stay under the free plan's 50-subrequest-per-invocation cap.

## Deploy

From this `worker/` directory:

```bash
npx wrangler login
```

```bash
npx wrangler kv namespace create QUOTES
```

Copy the printed `id` into `wrangler.toml` (replace `PASTE_KV_NAMESPACE_ID_HERE`), then:

```bash
npx wrangler deploy
```

Wrangler prints the Worker URL (e.g. `https://market-heatmap-quotes.<subdomain>.workers.dev`).
Test it:

```bash
curl "https://market-heatmap-quotes.<subdomain>.workers.dev/?refresh=1" | head -c 300
```

Check the refs route too:

```bash
curl "https://market-heatmap-quotes.<your-subdomain>.workers.dev/refs?refresh=1" | head -c 300
```

Then set `QUOTES_URL` in [`../js/app.js`](../js/app.js) to that URL and commit.

## Redeploying after code changes

Edit `src/index.mjs`, then `npx wrangler deploy`. Cron and KV bindings persist;
no need to recreate the namespace.

## Notes

- Cron `0 13-21 * * 1-5` = hourly during US market hours (UTC). Adjust in
  `wrangler.toml` and re-`deploy` to change it.
- Free tier limits (100k Worker req/day, generous KV) are far above this site's
  usage.
