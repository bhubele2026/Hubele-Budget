# B5 — the Amex anchor refresh on Plaid rows (B4 difference D3)

Branch `restore/b5-amex-anchor-fix` · base `origin/main` `ec36394c` · test DB `h2budget_test_b5` · no migration.

## The fix

`refreshAmexAnchor` (`artifacts/api-server/src/lib/amexAnchor.ts`) bound the card's account ids with
`plaid_account_id::text = ANY(${ids})`. Drizzle spreads the array into `ANY(($2))` and Postgres refuses it
("malformed array literal") whenever an Amex row carries a `plaid_account_id`, which is every Plaid-synced row.
The sync swallows the error (`plaidSync.ts` "best-effort"), so the anchor and the auto-anchored debt never moved.

The line now uses `inArray(sql\`plaid_account_id::text\`, ids)`, the way the file's other queries bind lists. The
query means exactly what it meant before; only the binding changed. Nothing else in the source changed.

## Figures (B4 scenario and the new regression test, same events)

| Step | Amex ending balance: before → after | `spine.debt.payoffPct`: before → after |
|---|---|---|
| Amex $86.33 charge (S1–S3b) | 500.00 → **586.33** | 50.000 → **41.367** |
| $20.00 refund (S4) | 500.00 → **566.33** | 50.000 → **43.367** |
| $100.00 payment (S5) | 500.00 → **466.33** | 50.000 → **53.367** |

Every other B4 figure is unchanged. D1 (a refund does not net) and D2 (the refund is not queued) stay documented and pinned.

## Tests

- **New: `amexAnchorPlaidRows.integration.test.ts`.** Three cases: the anchor, the debt balance and `payoffPct`
  after each refresh. They fail before the fix with "malformed array literal" (3 / 3).
- **Updated: `amexCheckingScenario.integration.test.ts` and its fixture** (copied from the B4 branch). The D3 pins
  and the D3 `it.todo` are gone, so the anchor and `% paid` are now asserted at the contract value. These steps
  failed before the fix (S1–S5, 6 / 7).

## ⚠️ Before merging: this switches a dormant write back on in production

Since Plaid Amex rows arrived, the refresh has failed on every Amex sync for every household. Once merged, each
Amex sync will run it:

- It recomputes `settings.amexAnchor` as the **net of every Amex row on file**, across all cards and all
  history (workbook `amex` plus `plaid:amex`).
- It writes that net to the name-matched "Amex / American Express" debt **when that debt still equals the last
  auto value, or when no auto value was ever recorded**.

Plaid history begins at the import cutoff, so that net is not necessarily the card's real balance. The debt the
name match finds may also be a different Amex card. `GET /amex/anchor` prefers a Plaid liability balance and the
debt row over the stored anchor, so the Amex page changes only where neither exists. `payoffPct` can move
wherever the name-matched debt is written.

Recommend checking the production households' `amexAnchor.lastAutoBalance` against their Amex debt rows before
merging. This is read-only; no prod write was made here.

**Still open (not changed here):** the "linked debt" lookup compares the debt's internal uuid with the card's
external Plaid id, so it can never match. The name fallback is what finds the debt, as before.

## Gates

| Gate | Result |
|---|---|
| `pnpm run typecheck` | exit 0 |
| Full API suite (serial, `h2budget_test_b5`, `CI=true`, `JOBS_MODE=off`) | 232 files · 2,502 passed · 0 failed · 4 todo (2 existing + D1, D2) |
| Golden (`forecastLedger.golden`) under `CI=true` | 12 / 12, snapshot untouched |
| `pnpm audit --prod` | exit 0: 1 high, which is the repo's existing ignore |
