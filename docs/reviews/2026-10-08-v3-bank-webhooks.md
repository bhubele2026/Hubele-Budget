# V3 — Automatic bank updates for banks that are already linked

Branch `finish/v3-bank-webhooks`, built on `origin/main` `2b664f6c`. Not merged, no PR.

**Plaid calls added: `itemWebhookUpdate` (free) only.** No call to `transactionsRefresh` was added, moved or loosened; a test proves the mocked client never saw one from the webhook path, the sync-end hook or the boot sweep.

## The gap

`POST /plaid/webhook` already verified Plaid's JWT and debounced into the free `/transactions/sync`, then `txn.arrived`, categorize and monitor. But Plaid only knows the address if it was given one: the link flow passes `PLAID_WEBHOOK_URL` for NEW links, and nothing ever told banks linked earlier. Those banks stayed silent, the app said nothing about it, and two comments still claimed banks sync only on a click.

## What changed

| Where | What |
|---|---|
| `lib/db/migrations/0114_plaid_item_webhook.sql`, `schema/index.ts` | `plaid_items.webhook_url`, `webhook_checked_at`, `webhook_error`; nullable, additive, idempotent. |
| `lib/plaidWebhookEnsure.ts` (new) | `ensureItemWebhook(item, { now })`: no URL -> `no_url`, no call. Same URL checked within 7 days -> `ok`, no call. Otherwise one `itemWebhookUpdate`; success stores URL + time and clears the error; failure stores a message cut to 300 chars with the access token removed. Never throws. `ensureAllItemWebhooks()` sweeps real items (synthetic seed rows skipped). |
| `lib/plaidSync.ts` | One call site, after the sync's commit and after the `txn.arrived` hand-off, so a refusal cannot block either. |
| `index.ts` | One boot sweep after `listen`, fire-and-forget; skipped when `JOBS_MODE=off` (tests) or Plaid is unconfigured. Stale comment fixed; the "~$500" history line kept. |
| `routes/plaid.ts` | `GET /plaid/items` adds `autoUpdates { on, reason: ok / no_url / not_registered / error, checkedAt, error }`. `on` only when the stored address equals the server's current one. |
| `routes/health.ts` | `/api/healthz` adds `plaid: { webhookUrlSet }` (boolean, never the address). |
| `render.yaml` line 10 | Comment now says clicks AND webhooks; refresh only behind Force confirm. |
| `openapi.yaml` + generated clients | Spec fields; codegen output (incl. dist) committed. |
| Household banks section | One hairline row per bank under "Synced …": On / Off with the four sentences from the brief. Sync and the billable Force refresh confirm are untouched. Words live in `words.ts` (`autoUpdatesWords`). |

## Tests

- `plaidWebhookEnsure.integration.test.ts` (10): no URL -> no call; same URL within 7 days -> no call; older than 7 days -> one call; different URL -> one call and columns stored; refusal stored (300 chars, token-free) and caller continues; boot sweep one call per real item; sync end registers once and a second sync makes no second call; a refusing bank still syncs and still emits `txn.arrived`; a signed webhook (verification disabled) -> debounced sync -> `txn.arrived` -> monitor enqueued, zero refresh calls; `GET /plaid/items.autoUpdates` for all four reasons; a bank quiet for 3 days gives the stale recap line and never "nothing spent".
- `healthz.integration.test.ts`: full shape now includes `plaid`; boolean-only test.
- h2: `words.test.ts` (6 cases), `household.test.tsx` (1 case: lines render, Sync still present).
- Mutants: 10 of 10 killed (no_url guard removed, 7-day window ignored, URL not stored, error not stored, token not redacted, no 300 cut, sweep includes seed rows, sync does not ensure, `on` when any URL, error reason dropped). Fails-before: the module and columns do not exist on the parent.

## Gates

| Gate | Result |
|---|---|
| `pnpm run typecheck` | clean |
| Codegen (CI style) | no drift |
| API suite | 221 files, 2403 passed, 2 todo |
| h2 suite, UTC | 483 passed, 3 skipped |
| h2 suite, `TZ=America/Chicago` | 484 passed, 2 skipped |
| Classic suite | 1248 passed, 4 skipped |
| `pnpm run build` + entry graph | OK: classic 576.1 / 580 KB; h2 dist 399.9 / 400 KB (the screen is lazy; nothing added to the open path) |
| `pnpm audit --prod` | 1 high, already on the ignore list; nothing new |

## What the owner must check in Render

1. Environment: `PLAID_WEBHOOK_URL=https://h2budget.onrender.com/api/plaid/webhook` (and `PLAID_WEBHOOK_VERIFICATION_DISABLED` NOT set to `true`).
2. After the deploy, `GET /api/healthz` shows `"plaid": { "webhookUrlSet": true }`. `false` means the variable is missing and every bank reads "Off — no webhook address on the server."
3. Household -> banks: each bank should read "Automatic updates: On" within a minute of boot (the boot sweep registers every existing bank, one free call each). A bank that reads "Off — the bank refused the address" shows Plaid's reason; the address must be reachable HTTPS.
4. Migration 0114 runs at boot before listen (additive; the old build keeps serving until healthy).
