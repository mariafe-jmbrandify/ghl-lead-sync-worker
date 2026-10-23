# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this project is

A Cloudflare Worker (TypeScript) that receives GoHighLevel (GHL) workflow
webhooks, stores leads in a D1 database, and pushes new leads to a Google
Sheet on a 5-minute cron. A Basic-auth admin page shows leads and sync runs.

```
GHL workflow ──POST /webhooks/ghl──▶ Worker ──▶ D1 (leads, sync_runs)
                                        │
                          cron */5 ─────┴──▶ Google Sheets API (append)
                                        │
             browser ──GET /admin──────▶ dashboard (Basic auth)
```

## Commands

- `npm test` — run the Vitest suite inside the Workers runtime (Miniflare)
- `npm run typecheck` — `tsc --noEmit`; must pass before any change is done
- `npm run dev` — local dev server; add `--test-scheduled` to trigger cron at `/cdn-cgi/handler/scheduled`
- `npm run db:migrate:local` / `db:migrate:remote` — apply D1 migrations
- `npm run cf-typegen` — regenerate `worker-configuration.d.ts` after editing `wrangler.jsonc`
- `npm run deploy` — deploy (only when explicitly asked)

## Layout

- `src/index.ts` — routing for `fetch` and the `scheduled` handler. Keep it thin.
- `src/webhook.ts` — secret check, payload validation, GHL field mapping, KV de-dupe
- `src/db.ts` — every SQL query lives here; nothing else talks to D1 directly
- `src/sheets.ts` — Google service-account JWT (WebCrypto) and Sheets append
- `src/places.ts` — Google Places (New) Text Search, KV result cache, per-lead enrichment
- `src/sync.ts` — batch sync: read pending → enrich → append → mark synced → log run
- `src/admin.ts` — server-rendered dashboard HTML
- `migrations/` — numbered D1 migrations; never edit one that has been applied, add a new file
- `test/` — one test file per area; `test/apply-migrations.ts` sets up the schema

## Rules

1. **Plan before building.** For any change touching more than one file, write a
   short plan (files, behaviour, tests) and confirm it before editing.
2. **Tests first-class.** Every behaviour change gets or updates a test. A task is
   only done when `npm run typecheck` and `npm test` both pass.
3. **No real network in tests.** External calls go through an injectable `fetchFn`;
   tests pass a fake. Never hit Google or GHL from the test suite.
4. **Secrets never in code.** `GHL_WEBHOOK_SECRET`, `ADMIN_TOKEN`,
   `GOOGLE_SERVICE_ACCOUNT_JSON` and `GOOGLE_PLACES_API_KEY` come from `wrangler secret put` (prod) or
   `.dev.vars` (local, gitignored). Never log secret values or full payloads.
5. **Fail safe.** Leads are marked synced only after Google confirms the write.
   A failed run must leave data retryable and record the error in `sync_runs`.
6. **Compare secrets with `safeEqual`** (constant time), never `===`.
7. **Escape all HTML output** with `escapeHtml`. Lead data is user-supplied.
8. **Sheets writes use `valueInputOption=RAW`** so form input is never run as a formula.
9. Keep dependencies at zero in `src/` — Workers runtime APIs only.

## GHL payload notes

GHL workflow "Webhook" actions send snake_case standard fields
(`contact_id`, `first_name`, `last_name`, `email`, `phone`, `tags`,
`contact_source`, `location.id`). `normalizeLead` also accepts camelCase so
custom webhook actions work. The standard action cannot add headers, so the
secret is accepted as `?key=` as well as the `x-webhook-secret` header.

## Claude Code setup in this repo

- `.claude/settings.json` — a PostToolUse hook runs `npm run typecheck` after every
  file edit, so type errors surface immediately.
- `.claude/agents/reviewer.md` — a read-only review subagent for security and
  failure-handling checks before a change is called done.
