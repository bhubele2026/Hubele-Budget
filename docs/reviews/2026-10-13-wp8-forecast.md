# WP8 — forecast no-double-count pins, split parts on the card, hook payoff words, and the card page billing every charge

Branch `fin/wp8-forecast`, from `origin/fin/integration` 22bc0903 with `fin/wp7d-ledger-matrix` (c87bc5ff) merged in. Lane 4 (plan `ancient-swimming-book.md`, root cause 10, WP8 code half). The harness kit's overlays and reconcile script are the lead's. Not merged. Not deployed.

- **Implemented:** the invariant test, split fix (i), label (v), and the owner's decision on the card page's charges.
- **Tested:** API integration (new and updated), web unit and component tests, full gates, the harness on `normal`.
- **Deployed / enabled:** no / nothing.

## What changed

### 1. `api-server/src/__tests__/forecastNoDoubleCount.integration.test.ts` (new: 7 tests, 5 todo)
The household: Wed 10/7 12:00 CT. Chase checking with a snapshot of $2,000.00 read Sun 10/4 08:00 CT, before the card payment. Amex Platinum. Weekly Spend stored at $450, the weekly hook. Weekly allowance plan $250.
- Last week: TARGET −120.00 on the card.
- This week: KROGER −40.00 (filed) and WALGREENS −25.00 (unfiled) on the card.
- 10/6: AMERICAN EXPRESS ACH PMT −120.00 from checking.

The cases, all through the real routes:
- **Case 1.** `explain.ledger.sinceAnchor` = `{ rowCount: 1, net: "-120.00" }`: the payment counts once, and no card row appears in `recentRows`. Spine `bank.balance` = cash-signal `bankToday` = explain `displayed.bankToday` = **1880.00**, to the cent.
- **Case 2.** No event's label names KROGER, WALGREENS, TARGET or the ACH payment. Exactly one hook event per Saturday (10/10, 10/17, 10/24, 10/31). This Saturday is −250.00 = `combinedWeekCharges` 65 + max(0, `remainingWeek` 185). Later Saturdays are −250.00, and `hookAmountIgnored` names the $450 plan.
- **Case 3.** The $120 payment puts last week's occurrence in `overdueAssumedPaid` (`card_payment`, remainder 0.00) and takes it off the curve. A $50 payment proves nothing: last week's −120.00 stays on the curve at 10/8, `overdue_assumed_unpaid`, and is not listed as paid.
- **Case 4.**
  - The split dialog's writes (part first with the charge's `source` and `plaidAccountId`, then the parent reshaped into equal halves) keep the part on the card. `GET /transactions?plaidAccountId=` lists both halves.
  - The bank balance, the card's charges (135) and the Saturday payoff do not move.
  - The dedupe count, the per-account pass, the /forecast pass and the cross-account pass (woken by an orphan row) all keep both halves.
  - A plaidAccountId from nowhere, or from another household, is a 400 that writes nothing; an empty one means no account.
- `it.todo`, the deferred gaps: (ii) `namesCardIssuer` knows only Amex; (iii) prepay/overpay; (iv) non-Amex cards and workbook purchases never reach the forecast; (vi) the Review badge counts the evidence row; (vii) Budget's own double counts.
- **Fails before.** Each fix reverted alone:
  - the route with the filed-only default: case 2 and case 4 fail;
  - the POST ignoring `plaidAccountId`: the three case-4 tests fail;
  - the dedupe without the Plaid-posting filter: the split test fails.

### 2. The owner's decision: the card page bills every charge (`routes/amex.ts`, `lib/amexAnchor.ts`)
- `GET /amex/weekly-payoff` calls `computeWeeklyPayoff(…, { allCoverages: true })`. That is every charge on the card, filed or not, less refunds: the basis the hook payoff bills.
- So the card page's "this week's charges" plus what is left of the week IS the Saturday payoff, to the cent.
- Spec: descriptions on `combinedWeekCharges` and `weekCharges`.
- `allCoverages: false` stays available; no caller uses it.

### 3. Split fix (i)
- **Spec and route:** `CreateTransactionInput.plaidAccountId` (nullable, max 128). `POST /transactions` checks it against the household's `plaid_accounts.account_id` and returns 400 `invalid_plaid_account` otherwise. Empty means no account.
- **`components/split-transaction-dialog.tsx`:** a part of a charge that has a Plaid account carries the charge's `source` and `plaidAccountId`; a charge with no account still makes manual parts. A pending charge disables "Split it" and says "This charge is still pending. Split it once it posts."
- **`lib/dedupeTransactions.ts`:** both passes and both probes consider Plaid postings only (`plaid_transaction_id is not null`): the per-account pass, the cross-account pass, the /forecast probe and the duplicate-count badge probe.
  - ⚠️ **Behaviour change:** a row with no Plaid transaction id is no longer a dedupe candidate. The #452 path where a survivor with no id adopts the loser's no longer runs.
  - Synced rows always carry ids; the dedupe test helper now gives its Plaid rows ids too, as production rows have.

### 4. Label (v) — display only
- `lib/forecastHooks.ts hookPayoffsOf(cashSignal, describe)` keys each hook occurrence by plan key, giving the card payoff (from the cash signal's events) and the plan (`hookAmountIgnored`). An occurrence paid on evidence (`overdueAssumedPaid`) gets the row that paid it.
- `hookPayoffWords` gives "card payoff $477.57 · plan $450", or "paid on evidence by AMERICAN EXPRESS ACH PMT · plan $450".
- `PlannedItemsList` → `PlanDropRow` shows that line under the date (`plan-hook-<item>-<date>`). The forecast page names the paying row from its bundle's transactions.
- The row's amount and the register's running balance still walk the stored plan. Whether the register should walk the payoff is the owner's open decision; nothing here changes it.

## Root cause (on main 8b869e79)
- `routes/amex.ts:587` called `computeWeeklyPayoff` with its filed-only default, while the hook (`everydayHooks.ts:159`) billed every coverage. The harness `hook.saturday` check failed on `normal` by exactly the unfiled charges ($14.25).
- `components/split-transaction-dialog.tsx:106-118` wrote parts as `source: "manual"` with no account, so they were bank rows by `isBankRow` and the checking balance read low by each part.
- `lib/dedupeTransactions.ts` selected every row on an account (and every `plaid:*` row across accounts), so equal parts that carry the card would have been collapsed.
- The register (`PlanDropRow.tsx`) showed the stored $450 under the bare item name while the curve took the payoff.

## Figures that move (fixture `normal`; `reconcile.mjs --compare` against the lead's before)
| Figure | Before | After | Why |
|---|---|---|---|
| Amex weekly payoff · this week's charges (weekly cards) | $312.40 | **$326.65** | The unfiled $14.25 on the weekly card is billed (owner's decision) |
| The same card's "this week's charges" on the card page and its Summary | filed only | + its unfiled charges | Same basis |
| Forecast register · Weekly Spend Oct 10 | "Weekly Spend $450.00" | "Weekly Spend −$450.00" + "card payoff $477.57 · plan $450" | Words only; the amount stays the plan |

- No cash, curve, low point, spine, position or debt figure moves.
- The other moves in the compare come from batch 1 (WP1, WP3), not this package.
- **Harness:** `hook.saturday` FAIL → **PASS** ("curve $477.57 vs charges $326.65 + remaining $150.92 = $477.57"). `label.payoffVsPlan` FAIL → PASS with `--landed wp7,wp8`. With that flag, **18/18 MUST checks hold** (exit 0); the one warning is WP6's spending scopes.
- The rendered `/forecast` on the fixture shows the five hook rows: "card payoff $477.57 · plan $450", then "card payoff $450.00 · plan $450" for each later Saturday. No page errors.

## Tests
- **New:**
  - `forecastNoDoubleCount.integration.test.ts` (above);
  - `lib/forecastHooks.test.ts` (3): keys, payoff, evidence, words, the unnamed fallback;
  - `pages/forecast/PlannedItemsListHooks.test.tsx` (2): the line on hook rows only, with the amount unchanged.
- `split-transaction-dialog.test.tsx` (+3): a card part keeps source and account; a manual charge still makes manual parts; a pending charge is off and says why, with nothing written.
- **Updated for the decisions:**
  - `refundsNet.integration.test.ts`: the Amex page's week 1 is 60.00, not 30.00, and equals the hooks' figure;
  - `_fixtures/amexCheckingScenario.ts`: S1/S2 show the unfiled pending $86.33 on the Amex page; S3a's filing moves nothing (a superseded-on-one-point line is added to the B4 note);
  - `dedupeTransactions.integration.test.ts`: the helper gives Plaid rows Plaid ids, and the adoption comments are corrected.

## Gates (on 543f7ddf, plus the B4 fixture fix)
- root `pnpm run typecheck`: clean.
- web vitest: UTC 2,052 passed / 3 skipped; America/Chicago 2,053 / 2 (216 files).
- API suite on `h2budget_test_fin_4`: 248 of 249 files passed (2,706 tests, 7 todo). The one failing file, `amexCheckingScenario`, encoded the old filed-only page rule; with its fixture updated it passes alone, 7/7.
- CI-style codegen: re-run clean.
- `pnpm run build` + `check-entry-graph`: OK at 619.8 KB of 622 KB (no change; the forecast page is lazy).
- `pnpm audit --prod`: exit 0, 1 ignored high.

## Unverified
- **Real data:** the card page's charges rise by Brad's unfiled card charges for the week; a read-only `/amex/weekly-payoff` would show by how much.
- A household that relies on the #452 adoption path, a legacy row with no Plaid id surviving with a Plaid twin. No synced row lacks an id; a read-only count of `plaid_account_id is not null and plaid_transaction_id is null` would say whether any exist.
- E2E (Clerk keys).
