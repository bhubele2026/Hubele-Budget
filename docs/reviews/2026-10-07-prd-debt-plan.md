# PR-D — debt plan engine: strategies, debt-free range, milestones, planned vs confirmed, genuine progress

Branch `reinvent/prd-debt-plan` off `main` `0352c748` (PR-0 + AI-0 merged). Migration range 0060–0069 (uses
`0060_debt_plan.sql`). No model calls anywhere in this package: every figure is computed in code.

## The owner's decisions this package rests on

- **North star: out of debt.** The plan answers "when, roughly" as a **range of months**, never one date, and every
  answer carries its assumptions.
- **% paid, never the amount owed** on landing surfaces. The spine gains two debt fields and neither is a balance:
  a milestone (label + month) and an amount **paid** this month.
- **Net the pending payments everywhere** (2026-08-23): the plan simulates netted balances
  (`withPendingPayments` → `effectiveDebtBalance`), as `payoffPct` does.
- **Planned ≠ confirmed** (approved plan, "Money layer"): a payment logged in the app is a claim until a bank row
  confirms it. This also decides the first OPEN item in `lib/bankLedger.ts` ("a manual 'Payment — <debt>' row logged
  beside the bank's own debit … both count today"): a confirmed claim now moves cash by 0, in the bank balance and
  the register alike.
- **The forecast may read low, never high.** The only cash change here removes a double-counted outflow; the bank
  row that confirmed the claim still counts, so cash can rise back to the bank's figure and never above it.

## Model rule

No model is called. `lib/avalanche-core/src/debtPlan.ts` / `debtProgress.ts` are pure; every amount in the four new
tables is written by deterministic code from bank and creditor rows.

## What changed

| Area | Change |
|---|---|
| `lib/avalanche-core/src/index.ts` | `simulate` takes an optional `newChargesPerMonth` (added after interest, before payments, to the debt the plan is paying extra to). **Absent or 0 the block never runs**: pinned byte-for-byte against the parent on 3 portfolios × 3–4 extras × 2 strategies (sha256 of the whole result). Re-exports the two new modules. Snowball already existed; nothing else in the engine changed. |
| `lib/avalanche-core/src/debtPlan.ts` (new) | `compareStrategies(debts, extra, startISO)` → avalanche / snowball `{ monthsToFreedom, debtFreeMonth, totalInterest, firstKill }`, `delta` (snowball − avalanche), `killMonths`; null — never `Infinity` or a fake date — when a plan never finishes. `debtFreeRange(debts, extra, newCharges, { strategy, startISO })` → three runs (plan as set / half the extra / plan + measured new charges) → `earliestMonth`, `latestMonth` (null = open-ended), `interestLow/High`, `assumptions`. `milestonesFor(sim, debts)` → each payoff, first card at $0, every 25% — **measured on `payoffPct`'s anchored basis** so "50% paid" means the landing's 50%. `planAssumptions` always lists the four: APR/12 monthly, payments at month start, minimums as stored *with their `min_payment_source`*, new charges as measured. |
| `lib/avalanche-core/src/debtProgress.ts` (new) | `normalizeCardAmount(source, amount)` — the one card-sign rule (workbook `amex` positive = charge; everything else, `plaid:*` included, negative = charge). `decomposeDelta` — integer-cent split into payments / interest / fees / new charges / credits / unexplained that sums to the delta exactly. `isTransferPair` (other debt, ≤ 5 days, ±1%) and `pairTransfers` (one to one, closest). `classifyLiabilityRow` (interest / fee / payment / charge / credit). |
| `lib/avalanche-core/src/cashRows.ts` | `CashRow.claimConfirmed?` and reason **`claim_confirmed`** (adds 0), checked after `held` / `not_bank`. Absent = false = every row before PR-D. |
| `lib/db` schema + `migrations/0060_debt_plan.sql` | `transactions.payment_state` (check `claimed`/`confirmed`), `transactions.confirmed_by_txn_id` (FK → transactions, ON DELETE SET NULL, unique where not null). Tables `debt_milestones`, `debt_statements`, `debt_ledger_events`, `debt_progress_snapshots` exactly as specified, **plus one column**: `debt_progress_snapshots.credits` (refunds are the fifth cause; without it the six columns could not sum to `delta`). All FKs and checks named identically in drizzle and SQL. No backfill (see Residual 1). |
| `lib/debtPaymentConfirm.ts` (new) | `confirmDebtPaymentClaims`: claims ≤ 90 days old pair with a **depository** Plaid row within 10 days and max($1, 1%), on evidence: same `debt_id` (`debt_tag`) or `plansPaidInFullByName`'s `card_payment` rule asked about that one pair; a row tagged to another debt is never evidence. Closest wins (tag, days, gap, posted before pending, id); one to one (+ unique index). A confirmation whose bank row was deleted reverts to `claimed`. `afterPlaidSyncDebtPass` = the hook. |
| `lib/debtLedger.ts` (new) | `syncDebtLedgerEvents` — posted rows on Plaid credit/loan accounts linked to a debt (and workbook `amex` rows only when a *manual* Amex debt exists) → `debt_ledger_events`, upsert on `transaction_id`; pending rows wait; a zero row loses its event. `recordDebtStatements` — liabilities statement facts → `debt_statements` (upsert per debt per date). |
| `lib/debtProgressSnapshot.ts` (new) | `writeDebtProgressSnapshots(hh, day)` — upsert per debt per day from `debt_balance_history` + ledger events (feed debts) or confirmed claims (manual debts; never both); transfer halves marked, `transfer_pair_txn_id` set. `writeAchievedMilestones(hh, day)` — insert-only (`pct_*` from `payoffPct`, `debt_zero:<id>`, `first_card_zero`). |
| `lib/debtPlan.ts` (new) | `computeDebtPlan` (GET /debt-plan) and `computeDebtHeadline` (spine), one internal function so they cannot disagree. Plan = `avalanche_settings.strategy` + `manual_extra` (the extra the forecast already puts on the curve); read-only (no `ensureSettings` insert). Confirmed = bank rows from resolutions `matched`/`partial` on `debt:*` / Avalanche extra, `overdueAssumedPaid` with `debt_tag`/`card_payment`, depository rows tagged to a debt, and claim-confirming rows — each row once. Genuine = confirmed − transfer pairs. New charges = feed charges over 90 days ÷ 3, transfer halves excluded. |
| `routes/debtPlan.ts` (new) | `GET /debt-plan`; owner-only (`requireOwner`, like `/ops`) `POST /debt-plan/reconcile` and `POST /debt-plan/snapshot?date=`. |
| `routes/spine.ts` | `debt.nextMilestone { label, estimatedMonth }`, `debt.paidDownMtd` from `computeDebtHeadline(signal)` over the spine's own 90-day signal. |
| `routes/debts.ts` | `POST /debts/:id/payments` writes `payment_state = 'claimed'` (row, amount and balance drop unchanged) and immediately tries to confirm it. |
| `lib/plaidSync.ts` | one line before the success return: `await afterPlaidSyncDebtPass(householdId, [...added, ...modified].map(t => t.transaction_id))` (best-effort, never fails a sync). |
| `lib/plaidLiabilities.ts` | gathers statement facts in the existing credit/student loops; one `recordDebtStatements` call after the link sweep. `LiabilityRow` unchanged. |
| `lib/ledgerCashRows.ts`, `lib/bankLedger.ts` | map `claimConfirmed`; the register's `registerAmount` handles `claim_confirmed` (0, not counted). |
| `lib/amexAnchor.ts` | **Fix folded in**: sums per source and applies `normalizeCardAmount`. |
| `openapi.yaml` + codegen | `/debt-plan` (+ reconcile, snapshot), `DebtPlan*` schemas, `SpineNextMilestone`, spine `debt.nextMilestone` / `debt.paidDownMtd` (required), optional `Transaction.paymentState` / `confirmedByTxnId`, `balanceReason` description. Generated code committed. |

## Figures that move (every one quantified on a synthetic fixture)

| Figure | When | Before → after | Proof |
|---|---|---|---|
| Cash (`bankToday`, the curve, the register) | a claim dated after the snapshot day **and** its bank row both on the ledger | snapshot 5,000.00, a 250.00 claim + its 250.00 bank debit: **4,500.00 → 4,750.00** (+250.00, the double count removed); the claim alone: 4,750.00 (unchanged) | `debtPlan.integration` "cash counts the 250.00 once"; `cashRows.test` (−500 → −250) |
| Amex anchor (`settings.amexAnchor`, and the auto-anchored debt row) | household mixing workbook `amex` and `plaid:amex` rows | 100 (amex charge) + 25 (Plaid credit) − 10 (Plaid charge): **115.00 → 85.00** | `amexAnchor.integration` (expectation changed, with the reason) |
| Amex anchor | Plaid-only rows | charges 50 + 30, payment 20: **−60.00 → 60.00** (same magnitude, sign corrected; a matching auto-anchored debt was written negative before) | `amexAnchor.integration` new case |
| Amex anchor | workbook-only rows | 60.00 → 60.00 | new case |
| Spine | always | two new fields (`nextMilestone`, `paidDownMtd`); existing fields unchanged | spine parity |

Nothing else moves. The new tables are written only by the new code; no existing reader reads them.

## Must not change — with the runs that prove it

| Must not change | Proof |
|---|---|
| `payoffPct` | claims never touch `debt_id`, amounts or the pending side; "payoffPct does not move when a claim is confirmed" (integration); spine parity's fixed `41.4682` unchanged |
| the cash curve, except a removed double count | `classifyCashRows` changes only for `claimConfirmed === true`; the golden snapshot and the household scenario pass unchanged (they hold no claims); cash tests unchanged |
| `bankToday` | as above; only a confirmed claim dated after the snapshot day moves it (quantified) |
| `reviewCount` | code unchanged. The parity fixture's expected count rose by 1 because the fixture gained a row (the tagged bank payment that makes `paidDownMtd` non-vacuous) — the spine still equals `/forecast/review-count` |
| any bill pair | `planMatch` untouched; a claim is a manual row with a `debtId`, which was already never evidence (`onChecking` false) |
| golden snapshot | not regenerated; `forecastLedger.golden` passes with `CI=true` |
| `GET /budget/months` | not touched (PR-E) |
| `simulate` | byte-identical on the pinned portfolios (avalanche and snowball, every extra) |

## Tests

New: `lib/debtPlan.test.ts` (32: 20 parent pins, strategies, range, milestones), `lib/debtProgress.test.ts` (11),
`lib/debtLedger.test.ts` (7), `cashRows.test.ts` +4 (`claim_confirmed`), `__tests__/debtPlan.integration.test.ts`
(17: claim → confirmed by tag / by card-payment name / at once on logging; no-match ×4; two candidates → closest and
the tolerance edge; one-to-one + revert on delete; `payoffPct` unmoved; liability ledger idempotent + pending +
cascade; statements upsert; snapshot to the cent + idempotent + transfer pair; milestones insert-only; owner gates;
`/debt-plan` shape + no-balance walk; household isolation; transfer pair not genuine; reconcile).
Changed: `spineParity` (+1 parity row for both new fields, law extended to any key under `debt` matching
`/balance|owed|remaining/i`), `amexAnchor` (115 → 85 with the reason, +2 cases), `schemaMigrations` (the replay
covers the two new columns; the scratch copy now includes indexes so the self-FK has a key to point at).

### Fails before

FAILS_BEFORE_TABLE

### Mutants (each applied alone on this branch, then reverted)

MUTANTS_TABLE

## Gates

GATES_TABLE

## Residuals

1. **No backfill of old payments.** "Payment — <debt>" rows written before this release keep `payment_state` NULL:
   they are not claims and are never paired, so historical double counts in the register stay as they were. A
   backfill would move historical register balances; it needs the owner's word (Question 1).
2. **Nightly snapshot not scheduled.** `jobs/register.ts` has no `metrics.snapshot` handler yet, so nothing calls
   `writeDebtProgressSnapshots` / `writeAchievedMilestones` nightly. TODO for the jobs package (PR-E): call both for
   every household at 03:30 Chicago. Until then `POST /debt-plan/snapshot` runs them.
3. **"Confirmed" is bank-side only.** A payment made from an account that is not linked (or not `depository`) is
   never confirmed; the card-side "PAYMENT THANK YOU" row lands in the ledger as a `payment` event and explains the
   snapshot delta, but does not count toward `confirmedMtd`.
4. **A wrong pair could read cash high for a few days**: if an unrelated bank row matching the debt tag / card name,
   amount (±max($1,1%)) and window confirms a claim whose real debit has not posted, that claim stops counting until
   the real row arrives. Tight evidence (tag or card-payment name) keeps this narrow.
5. **Workbook `amex` rows** feed the ledger only for a *manual* Amex debt (a Plaid-linked card has its own feed);
   with no such debt they are not classified.
6. `pnpm audit --prod`: the three advisories known on `main` (another PR fixes them) — reported, not fixed.

## Questions for the owner

1. Backfill old "Payment — <debt>" rows as claims (and let the pass confirm them)? It would remove past double
   counts from the Chase register's history; today's `bankToday` would not move (those rows are inside the snapshot).
2. Milestone basis: "50% paid" uses the landing's `payoffPct` (anchored originals). The brief said "25% of the
   starting total"; I used the anchors so the plan and the landing can never disagree about when 50% happened, and
   fall back to the starting total only when no debt has an anchor. Keep?
3. "First card": by `debts.type` (credit/card), and by name only when the type was never set. Acceptable?
