# PR-E — progress measurement: nightly metrics snapshot, debt snapshots scheduled, GET /metrics, no more writes on GET

Branch `reinvent/pre-metrics` off `main` `87c892bf`. Migration range 0110–0119 (uses `0110_household_metrics_daily.sql`).
No model calls anywhere in this package: every figure is computed in code from stored rows.

## The owner's decisions this package rests on

- **The north star is out of debt, and progress has to be measurable.** PR-D wrote the debt progress snapshots when a
  person called a route; nothing measured the household day by day. This package schedules the snapshots and records one
  metrics row per household per day, so "are we getting there" is a query, not a recollection.
- **A read changes nothing.** `GET /budget/months/:monthStart` ran ~10 write passes on the way to answering (seed, category
  migration, system categories, auto_debts / auto_bills / Avalanche-payment syncs, carry-forward inserts). That made a
  page view a database write and made "the numbers on screen" depend on who looked first. They now run from writes and the
  nightly job.
- **Code computes every figure** (CLAUDE.md §1). The metrics are sums of stored snapshot rows and copies of figures the
  money position, spending facts and freshness already compute.

## What changed

| Area | Change |
|---|---|
| `lib/avalanche-core/src/metrics.ts` (new) | `computeDailyMetrics(inputs) → DailyMetrics`, pure and deterministic; integer-cent sums. `keepPointInTime` merges a past-day recompute. `METRICS_VERSION = 1`. Re-exported from `index.ts`. |
| `lib/db` schema `metrics.ts` + `migrations/0110_household_metrics_daily.sql` | `household_metrics_daily (id, household_id → households ON DELETE CASCADE, as_of date, version int, metrics jsonb, computed_at)`, unique `(household_id, as_of)`. Additive, idempotent; `metricsSchemaParity` runs the SQL twice and compares it to drizzle's. |
| `src/lib/metricsSnapshot.ts` (new) | `computeMetricsForDay` (read-only) and `writeDailyMetrics(householdId, ownerUserId, asOfDay)`: upsert, only replacing a row whose `version <=` the new one. A future day is refused. |
| `src/jobs/handlers/metricsSnapshot.ts` (new), `register.ts` (2 lines) | Queue `metrics.snapshot` (constant already existed). Cron `30 3 * * *` America/Chicago fans out one job per household with a debt or a Plaid item; each job is a pg-boss singleton `metrics:<household>:<day>`. The per-household pass: this month's budget syncs (failure logged, never fatal) → `writeDebtProgressSnapshots` → `writeAchievedMilestones` → `writeDailyMetrics`. |
| `src/routes/metrics.ts` (new), `routes/index.ts` (2 lines) | `GET /metrics?from&to` (requireAuth, household-scoped, ≤ 93 days inclusive, default last 30 days, read-only) → `{ from, to, rows: [{ asOf, version, computedAt, metrics }], latest }`. `POST /metrics/recompute?date=` (owner) runs the pass now; the date may not be in the future. |
| `openapi.yaml` + codegen | `/metrics`, `/metrics/recompute`, `DailyMetrics`, `MetricsDay`, `MetricsResponse`, `MetricsRecomputeResult`, tag `metrics`. Generated code committed; CI-style drift check clean. |
| `routes/budget.ts` | **GET /budget/months/:monthStart and GET /budget/categories write nothing.** The passes became two exported functions: `prepareBudgetCategories` (the default seed, once, never-seeded households only, + the three system categories) and `prepareBudgetMonth` (v2 migration + system categories once per process, May-2026 gate, `syncAutoDebtCategories`, bill-link heal, `syncAutoBillsFromRecurring`, `syncAvalanchePaymentCategory`, carry-forward lines). The carry-forward is now `carryForwardLines({ persist })`: the GET computes it in memory (`persist: false`), the write path stores it. Called from: `POST/PATCH/DELETE /budget/categories` (`prepareBudgetCategories`), `POST /budget/lines` (both), the pin routes (already synced), and the nightly job (`prepareBudgetMonth`, never seeds). |
| `src/lib/budgetDebtSync.ts` (new), `routes/debts.ts`, `lib/plaidLiabilities.ts` | `syncAutoDebtCategories` moved out of `budget.ts` unchanged. `syncDebtBudgetAfterWrite` (best-effort, never throws) runs after `POST /debts`, `POST /debts/sync-minimums`, `PATCH /debts/:id`, link / unlink / refresh / payments, `DELETE /debts/:id`, and at the end of the Plaid liabilities refresh. |

## The metric definitions

| Field | Definition | Source |
|---|---|---|
| `totalDebtEffective` | Σ netted debt balances (`effectiveDebtBalance`, pending payments subtracted, floor 0). Today: the live debt rows through `withPendingPayments`. Past day: the latest stored snapshot balance per debt on or before the day (kept from the stored row if one exists). `null` with no debts — never a false 0. | `debts`, `debt_progress_snapshots` |
| `debtPaidDownGenuineMtd` | Σ \|`payments_confirmed`\| over this month's snapshot rows with **no transfer-pair marker**. A marked row is excluded whole (it cannot be split), so this reads low, never high. | `debt_progress_snapshots` |
| `interestChargedMtd` | Σ (`interest` + `fees`) over this month's snapshot rows: what the creditors charged. | same |
| `newChargesMtd` | Σ `new_charges` this month. Balance-transfer halves cannot be split out of a row, so this can read high, never low. | same |
| `discretionaryWtd` | The money position's own rule over this household week: weekly-allowance spend + spend not yet filed (`allowance_weekly` + `needs_classification`). Equals `position.spentWeekDiscretionary` (tested). | `classifyMovement` / `spendAmount` |
| `discretionaryMtd` | The same rule from the 1st (clamped to the tracking start) through today. | same |
| `weeklyCap`, `withinPlan` | The position's `weekCap` (null = no cap set) and verdict. | `buildMoneyPosition` |
| `confirmedPaymentsMtd` | Σ \|`payments_confirmed`\| this month, transfers included. | snapshots |
| `milestonesReached` | Count of `debt_milestones` with `achieved_on <= asOf`. | `debt_milestones` |
| `uncategorizedCount` | Uncategorized purchases this month (`buildSpendingFacts().uncategorized.transactionCount`). | spending facts |
| `reviewQueueSize` | Open categorization decisions (`listReviewQueue().total`). | review queue |
| `dataCompleteness.stale` / `staleReason` | `computeBankFreshness` — the spine's bank verdict. | freshness |
| `dataCompleteness.accountsSilentDays` | The longest any Plaid item has gone without a good sync, whole household days; null with no item to judge. | `plaid_items.last_synced_at` |

**Two kinds of field.** *Flows* (paid down, interest, new charges, confirmed payments, milestones) come only from stored
rows, so recomputing any past day gives the same numbers (tested after balances, later snapshots and later milestones all
changed). *Observations* (total debt, the week figures, counts, freshness) are what was true when the job ran: live for
today; on a recompute of a past day they are **kept from the row stored that day**, and are `null` if there was none. The
past is never refilled from today's data.

**Month attribution.** A snapshot row is labelled with the day the job captured it and covers the window since the previous
snapshot, so an event on the last evening of a month lands in the next month's first row.

## Figures that move

None. The new table and endpoint are new. The budget GET responses are byte-identical (below). The budget write routes and
the debt routes now also run the syncs the GET used to — the same functions, on the same inputs.

## Must not change — with the runs that prove it

| Must not change | Proof |
|---|---|
| The budget month response | The same seeded household (a manual category with a prior-month line, an active debt, an income bill, an Avalanche extra) read for 2026-09, the current month and 2026-12, once on the parent (the GET syncs) and once here (after `prepareBudgetMonth`): **byte-identical after normalizing generated ids**; the categories list differs only in the run-specific `userId` / `createdAt`. Also pinned in `budgetNoWritesOnGet`: the response is the same with or without a sync having just run. |
| A carried-forward line | Still shown with the prior month's planned amount and note; `id` is `null` until stored (the response already allowed a null `id`). |
| Debt categories / lines | `syncAutoDebtCategories` is moved verbatim; the existing categories / pinning / plan-by-source suites pass. |
| The money position, spine, debt plan | Untouched; `spineParity` and `debtPlan` pass. |
| `payoffPct`, cash, forecast | Untouched. |

## Behavior changes to know about (no figure moves; when a row appears does)

- A household never touched by a write has **no seed rows** until its first budget write (`POST/PATCH/DELETE
  /budget/categories`, `POST /budget/lines`) or `POST /budget/seed-defaults`. Classic already calls the seed route when the
  list has no budget row. A new household in the new app is seeded by its first category write.
- A household whose debt categories were never synced gets them on its **next debt write or the next nightly run**
  (03:30 Chicago), not on the next page view.
- Auto-bills categories for a newly added income bill and the Avalanche payment line refresh on the next budget write or the
  nightly run, not on the next page view. The month response still derives every *planned amount* for bill-backed and debt
  categories live from Bills and Debts; only the category row / stored line for a brand-new income item waits.
- `GET /budget/categories` returns the stored list; a household whose system rows (Uncategorized / Transfer / Ignore) were
  never ensured sees them after its first month pass or write.

## Tests

New: `lib/metrics.test.ts` (11: every field worked by hand, determinism, cents, month window, nulls, discretionary rule,
silent days, `keepPointInTime`), `__tests__/metricsSchemaParity` (2), `__tests__/metrics.integration` (16: today's row
including the tie to `buildMoneyPosition`, the future refused, upsert, definition version older / newer, past-day
reproducibility and kept observations, job idempotency and fan-out singletons, `/metrics` scoping / range / cap / defaults
/ latest / writes nothing, `/metrics/recompute` owner gate and validation), `__tests__/budgetNoWritesOnGet` (8: two GETs
change no row across seven tables by content hash, an untouched household is not seeded by a read, response parity,
in-memory carry-forward, debt POST / PATCH / DELETE sync, the nightly run syncs and does not seed, the first budget write
seeds).

Changed: seven older integration files (`budgetCategoryMigration`, `budgetPlanBySource`, `deploySafeCategoryPasses`,
`ignoreCategory`, `may2026BudgetAmounts`, `seedDefaultsOnce`, `settingsPreferencesServerKeys`) pinned the behavior of the
passes *by triggering them with a GET*. What they pin is unchanged — the passes, their order, their gates — only the
caller moved. Their `requireAuth` mock now runs `_helpers/budgetPassesOnRead.ts`, which calls exactly what that GET used to
run (`prepareBudgetCategories` for the list, `prepareBudgetMonth` for a month) before the request is answered. No assertion
changed.

### Fails before

On the parent `87c892bf` source (budget.ts, debts.ts, plaidLiabilities.ts restored; the DB pushed from this branch):

| Test file | On the parent | Symptom |
|---|---|---|
| `lib/metrics.test.ts` (11) | file fails to load | `computeDailyMetrics` is not exported |
| `__tests__/metrics.integration` (16) | file fails to load | `routes/metrics` does not exist |
| `__tests__/metricsSchemaParity` | fails | `0110_household_metrics_daily.sql` does not exist |
| `__tests__/budgetNoWritesOnGet` (8) | **8 / 8 fail** | the two-GET fingerprint changes (the GET seeds, syncs and inserts); `prepareBudgetMonth` / `prepareBudgetCategories` do not exist |

### Mutants (each applied alone, then reverted; new tests only)

| Mutant | Caught by |
|---|---|
| M1 transfer-marked payments counted as genuine | metrics unit + integration (2) |
| M2 fees not folded into interest | unit + integration (2) |
| M3 total debt ignores the pending netting | integration (1) |
| M4 month window ignored | unit + integration (2) |
| M5 definition-version guard removed | integration "never overwrites a newer definition" |
| M6 past day refilled from today | integration "reproducible" |
| M7 range cap 93 → 100 | integration "caps a range at 93 days" |
| M8 `/metrics` not household scoped | integration (2) |
| M9 GET month syncs debts again | no-writes (2) |
| M10 GET month stores the carry-forward | no-writes (2) |
| M11 GET categories seeds again | no-writes (3) |
| M12 `POST /debts` does not sync | no-writes (1) |
| M13 nightly skips the budget sync | no-writes (2) |
| M14 discretionary counts `unplanned` | unit + integration (2) |

## Gates

| Gate | Result |
|---|---|
| `pnpm run typecheck` | clean |
| Codegen drift (CI style: `lib/api-zod/dist`, `lib/api-client-react/dist` and the tsbuildinfo deleted, regenerated) | `git status` clean after committing |
| API suite (serial, `h2budget_test_pre`, `CI=true`) | **214 files passed; 2,268 tests passed, 13 todo** (the parent's 210 files / 2,231 plus this package's 4 files / 37 tests) |
| h2 suite | 26 files passed, 1 skipped; 393 tests passed, 4 skipped |
| Classic suite | 140 files passed, 1 skipped; 1,248 tests passed, 4 skipped |
| `pnpm run build` | exit 0 |
| Entry-graph guard, classic | OK, 576.1 KB of 580 KB (unchanged by this package) |
| Entry-graph guard, h2 | OK, 400.0 KB of 400 KB (unchanged by this package) |
| `pnpm audit --prod` | "1 high (1 ignored)" — the documented ignore; 0 un-ignored |

## Residuals

1. **Genuine paid-down is conservative.** The snapshot row stores one `transfer_pair_txn_id`, not the transfer amount, so a
   row holding a real payment and a transfer half is excluded whole; `newChargesMtd` cannot drop balance-transfer halves.
   Exact figures need a `transfer_payments` column on `debt_progress_snapshots` (additive, a PR-D table) — not done here.
2. **Observations for a day nobody ran** are `null`; there is no backfill of history. The first row is the first night.
3. **No live-gap fill.** A skipped night leaves no row for that day; the next night's flows still cover the gap (its snapshot
   window starts at the previous snapshot), and `GET /metrics` returns what exists.
4. **`uncategorizedCount` is this month's**, not all-time, to match the spending facts it reads.
5. Auto-bills rows for a brand-new income item wait for the next budget write or the nightly run (see above). Hooking
   `routes/recurring.ts` / `routes/avalanche.ts` writes to `prepareBudgetMonth` would close it; those files were outside this
   package.

## Questions for the owner

1. Should a *read* of an unseeded household's category list in the new app stay empty until a first write, or should the
   new app call `POST /budget/seed-defaults` when the list is empty, as classic does?
2. Should the metrics also be written for the day that just ended at 03:30, so a month's final overnight window is
   attributed to that month? Today it lands in the 1st's row.
