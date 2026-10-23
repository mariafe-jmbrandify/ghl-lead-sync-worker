# GHL Lead Sync Worker

A Cloudflare Worker that turns GoHighLevel webhooks into a reliable lead pipeline:

1. A GoHighLevel workflow posts each new contact to the Worker.
2. The Worker validates it and stores it in a **D1** database (one row per contact, no duplicates).
3. Every 5 minutes a **scheduled job** appends new leads to a **Google Sheet**.
4. A password-protected **admin page** shows recent leads and every sync run, with a "Sync now" button.

Built with Claude Code, in TypeScript, with no runtime dependencies — only Workers APIs.

![Admin dashboard](docs/dashboard.png)
*Admin page from a local run with no Google credentials set, showing how sync errors are reported.*

## How it works

```
GHL workflow ──POST /webhooks/ghl?key=…──▶ Worker ──▶ D1: leads, sync_runs
                                              │        KV: de-dupe keys, Google token cache
                                cron */5 ─────┴──▶ Google Sheets API (append, RAW)
                                              │
                  browser ──GET /admin────────▶ dashboard (Basic auth)
```

| Endpoint | Purpose |
|---|---|
| `POST /webhooks/ghl` | Receives GHL webhooks. Secret via `?key=` or `x-webhook-secret` header. |
| `GET /admin` | Dashboard (Basic auth, password = `ADMIN_TOKEN`). |
| `POST /admin/sync` | Runs a sync immediately. |
| `GET /health` | Health check. |

## Reliability and security decisions

- **Idempotent:** contacts are upserted on `contact_id`, and identical retries within 10 minutes are skipped using KV. A contact is appended to the sheet once.
- **No data loss on failure:** leads are marked synced only after Google confirms the write. A failed run is logged in `sync_runs` and retried by the next cron tick.
- **Secrets:** compared in constant time, stored as Wrangler secrets, never logged.
- **Input limits:** 64 KB body limit, JSON shape validation, clear 4xx errors.
- **Safe output:** dashboard HTML is escaped and served with a strict Content-Security-Policy; Sheets writes use `RAW` so form input can't run as a formula.
- **Google auth without libraries:** the service-account JWT is signed with WebCrypto, and the access token is cached in KV for ~55 minutes.

## Tests

21 tests run inside the real Workers runtime (Miniflare) with a real local D1 and KV:

```bash
npm install
npm run typecheck
npm test
```

They cover webhook auth, payload mapping, duplicates and updates, bad input, JWT signing (verified against a generated RSA key), Sheets success and failure paths, token caching and refresh, dashboard auth and HTML escaping, and the cron handler. Google is never called from tests; an injected fake `fetch` stands in.

## Run locally

```bash
cp .dev.vars.example .dev.vars          # fill in values
npm run db:migrate:local
npx wrangler dev --test-scheduled

curl -X POST "http://localhost:8787/webhooks/ghl?key=YOUR_SECRET" \
  -H "content-type: application/json" \
  -d '{"contact_id":"demo_1","first_name":"Ana","email":"ana@example.com","contact_source":"Website form"}'

curl http://localhost:8787/cdn-cgi/handler/scheduled   # trigger the cron
open http://localhost:8787/admin                        # any username, password = ADMIN_TOKEN
```

## Deploy

1. **Cloudflare resources**
   ```bash
   npx wrangler login
   npx wrangler d1 create ghl-leads            # paste database_id into wrangler.jsonc
   npx wrangler kv namespace create KV         # paste id into wrangler.jsonc
   npm run db:migrate:remote
   ```
2. **Google Sheet**
   - In Google Cloud Console, enable the Google Sheets API and create a service account with a JSON key.
   - Share your sheet with the service account's `client_email` as an Editor.
   - Add a `Leads` tab with headers: `Received, Contact ID, First name, Last name, Email, Phone, Source, Tags`.
   - Put the sheet ID (from its URL) in `SHEET_ID` in `wrangler.jsonc`.
3. **Secrets**
   ```bash
   npx wrangler secret put GHL_WEBHOOK_SECRET
   npx wrangler secret put ADMIN_TOKEN
   npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON   # paste the whole JSON key
   npm run deploy
   ```
4. **GoHighLevel**: in a workflow (e.g. trigger *Contact Created* or *Form Submitted*), add a **Webhook** action with URL
   `https://ghl-lead-sync-worker.<your-subdomain>.workers.dev/webhooks/ghl?key=<GHL_WEBHOOK_SECRET>`.

## Project structure

```
src/index.ts     routing + cron handler
src/webhook.ts   auth, validation, GHL field mapping, de-dupe
src/db.ts        all D1 queries
src/sheets.ts    Google JWT auth + Sheets append
src/sync.ts      batch sync logic
src/admin.ts     dashboard HTML
migrations/      D1 schema
test/            Vitest suites (Workers runtime)
CLAUDE.md        project rules for Claude Code
.claude/         typecheck hook + reviewer subagent
```

## Roadmap

- Enrich leads with Google Places (business address, rating) before syncing
- Update existing sheet rows when a contact changes, instead of append-only
- Stripe webhook to mark leads as paying customers
