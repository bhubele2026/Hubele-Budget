# PR-H — the household money model, a shared foundation (owner decisions 7 and 12)

- **Base:** `main` = `df5d8b0b`.
- **Branch:** `feat/household-money-core`.
- **Owner decision 7:** one household calculation — bank balances, weekly spending, bills and debt payments fit
  together without counting money twice. Cash moves only through checking rows and unresolved plans; card rows never
  move cash, they size a future Amex payoff plan.
- **Owner decision 12:** a confirmed bill match should stop counting a second time toward allowance/weekly spend (the
  bill is already in the plan). This PR does **not** apply decision 12 to any displayed figure — it only proves,
  ahead of time, exactly where it will change something.

This PR lays the foundation three later PRs (Spending, the Budget allowance card, and PR8r/PR10's forward switch)
will build on. **It changes no displayed figure.** Every existing test passes unmodified; the new code is additive.

## What changed

### 1. The pure core — `lib/avalanche-core/src/householdMoney.ts`

`classifyMovement(row, ctx)` returns exactly one `coverage` and one `timing` for any ledger row:

- `coverage` ∈ `transfer | debt_payment | card_payment | bill_matched | unplanned | allowance_monthly |
  allowance_weekly | reimbursable | needs_classification | income | excluded`.
- Precedence, first match wins:
  1. the core spending rule (`classifyOutflow`, called with `reimbursableIsSpend: true` so its own reimbursable rule
     cannot pre-empt steps 2-6) — transfer / debt payment / card payment / income / excluded (bank noise folds into
     `transfer`, exactly as the Spending report already buckets it);
  2. a **confirmed** bill match (`ctx.matchedTxnIds`) → `bill_matched`, with the flag conflict reported, never hidden:
     a weekly/monthly flag on a match → `conflict: "flag_ignored_matched"`; an unplanned flag on a match →
     `conflict: "unplanned_on_matched"`;
  3. `unplanned_allowance` → `unplanned`;
  4. `monthly_allowance` → `allowance_monthly`;
  5. `weekly_allowance` → `allowance_weekly`;
  6. `reimbursable` → `reimbursable`;
  7. otherwise → `needs_classification`.
- An inflow (`classifyOutflow`'s `not_outflow`) is decided on its own footing: real income (`isRealIncome`) is
  `income`; every other inflow (transfer in, refund, debt draw) is `excluded`.
- `timing` ∈ `{kind:"checking", date}` (same bank-row identity `isBankRow`/`classifyCashRows` use) |
  `{kind:"card", accountId, date}` (an Amex ledger row — `CARD_LEDGER_SOURCES`, mirroring `AMEX_TXN_SOURCES` in
  `amexAnchor.ts`; the two are pinned equal by `moneyContext.test.ts`) | `{kind:"none"}`.

`everydayPlan(periodStartSunday, settings, overrides)` returns `{weeklyCents, monthlyCents}`: the week's
`weeklyAllowanceOverrides["<Sunday ISO>"]` when set, else `settings.weeklyAllowanceAmount`; `monthlyCents` is always
`settings.monthlyAllowanceAmount` (no per-period monthly override exists). Moved verbatim from the client's own
computation (`command-center.tsx`'s `weekView`, `allowances.tsx`).

Both are exported from the package index and re-exported through `artifacts/api-server/src/lib/spendingFilter.ts`
(the server's existing import path for shared avalanche-core rules — "add nothing here that decides spending" still
holds: `classifyMovement` doesn't decide anything new, it labels).

### 2. The Amex card cadence extraction — `artifacts/api-server/src/lib/amexCardCadence.ts`

`discoverAmexCards(householdId, ownerUserId?)` is `computeWeeklyPayoff`'s own card-discovery + cadence block
(`amexAnchor.ts`, was ~:273-345), moved verbatim: same query, same `cadenceFor` closure, same brand defaulting
(Blue → monthly, Platinum/Silver → weekly). `classifyAmexBrand`/`AmexBrand` moved with it and are re-exported from
`amexAnchor.ts` for compatibility. `computeWeeklyPayoff` now calls `discoverAmexCards` instead of inlining the query,
and `moneyContext.ts`'s `loadMoneyContext` calls the *same* function for its cadence map — so the payoff plan and the
money model can never discover a different set of cards or disagree on one's cadence.

**This is a move, not a new calculation.** All 9 Amex-related test files (40 tests) pass unchanged, including
`amexWeeklyPayoffReimbursable.integration.test.ts`, which exercises the real `/api/amex/weekly-payoff` route end to
end — the strongest available proof `computeWeeklyPayoff`'s output is byte-identical.

### 3. The server loader — `artifacts/api-server/src/lib/moneyContext.ts`

`loadMoneyContext(householdId, range)` reads, once, everything a `classifyMovement`-based figure needs, every query
bounded to `range`:

- the allowance amounts and `preferences.weeklyAllowanceOverrides` — **read server-side for the first time**; today
  only the web's `allowances.tsx` and `command-center.tsx` read overrides, off `useSettings()`;
- confirmed bill matches (`loadConfirmedBillMatches`): a `forecast_resolutions` row with status `matched`/`partial`
  whose `matched_txn_id` is a transaction **dated in `range`** — bounded by the matched transaction's own date, not
  the bill's `occurrence_date`, so a reschedule can't silently drop a match out of the window it's being asked about;
- superseded-pending pairs for `range`, filing included — `findSupersededPendingForRange`, never reimplemented;
- the tracked checking account's external Plaid id — `resolveLedgerAccounts`, never reimplemented;
- the Amex cadence map — `discoverAmexCards`, keyed by external account id.

Nothing calls `loadMoneyContext` from a live request path yet (see "Wiring", below).

### 4. Wiring — real code, not called from any live request path yet

Per file:

- **`artifacts/api-server/src/lib/spendingFacts.ts`** — exports `classifierHouseholdSpend(rows, ctx, opts)`: the
  classifier's view of `householdSpend.total`, given the SAME effective-filing rows `buildSpendingFacts` sums (a new
  `plaidAccountId` column was added to its existing `txns` SELECT so a row carries what `classifyMovement` needs;
  everything else in `buildSpendingFacts` is untouched).
- **`artifacts/api-server/src/lib/budgetActuals.ts`** — exports `classifierAllowanceRows(rows, supersede, ctx,
  movement, opts)`: the classifier's view of the allowance card's bucket rows, given the same
  `aggregateBudgetMonth` inputs plus the three identity fields (`occurredOn`, `plaidAccountId`, `pfcDetailed`) that
  file's own query doesn't select today (`ClassifierBudgetMonthRow`). `aggregateBudgetMonth` itself is untouched.
- **`routes/spine.ts` and `routes/budget.ts` have no diff.** The spine's `spentMonth`/`spentWeek` and the Budget
  allowance card's actuals are computed by `buildSpendingFacts`/`aggregateBudgetMonth`, which is where the wiring
  above lives — there is nothing left for the routes themselves to change for this PR's purpose.

**Why not wired into the live request path.** Calling `classifyMovement` from inside `buildSpendingFacts` or
`aggregateBudgetMonth` today would mean: a new DB query (`loadConfirmedBillMatches`) and a second full pass over the
range's rows, on every spine load and every Budget page open, for a number nothing displays. That is exactly what
this codebase's entry-graph and query-shape rules (CLAUDE.md §2 — no duplicate/overlapping queries, no unbounded
work with nothing to show for it) exist to keep out. The exported `classifierHouseholdSpend`/`classifierAllowanceRows`
functions are the switches PR8r/PR10 will flip — real, tested, production-quality code, living in the named files —
once a displayed figure is ready to move.

## Proof no figure moves

- **The golden test is untouched and green:** `forecastLedger.golden.integration.test.ts` — byte-identical.
- **The spine parity test is untouched and green:** `spineParity.integration.test.ts` — every spine field still ties
  to its owning endpoint to the cent.
- **The full existing suite passes unmodified:** 150 API test files / 2019 tests (7 todo), 139 web test files / 1148
  (UTC) and 1149 (America/Chicago) tests. Nothing pre-existing changed shape or value.
- **No route, no response shape, and no `lib/api-spec/openapi.yaml` changed.** Codegen was not run because there was
  nothing to regenerate.
- **Sum-invariant tests prove the classifier reproduces today's figures**, apart from the two differences below,
  which are asserted separately with both figures pinned:
  - `spendingFactsClassifierParity.integration.test.ts` — a mixed fixture (plain spend, transfer, tagged debt
    payment, a card-payment pattern, a plain reimbursable charge, an unplanned-flagged charge, an uncategorized
    charge) with **no** bill match and **no** reimbursable+flag row: `classifierHouseholdSpend(...,
    {billMatchedCounts: true}).total` equals `buildSpendingFacts(...).householdSpend.total` to the cent.
  - `budgetActuals.test.ts` — the analogous fixture for the allowance card: `classifierAllowanceRows(...,
    {billMatchedCounts: true})` equals `aggregateBudgetMonth(...).allowanceRows` row-for-row.

## The two differences PR8r/PR10 will introduce (documented, not applied)

Both are inherent to the precedence **as specified** for `classifyMovement`, not implementation bugs; both are
pinned by a test carrying today's figure and the classifier's figure side by side.

### Difference 1 — a confirmed bill match

**Today:** `classifyOutflow` has no concept of a bill match. A categorized, non-excluded charge counts toward
`householdSpend`/`realSpend` (Spending) and, if flagged, toward its allowance bucket (Budget) — matched or not.

**Forward (decision 12, PR8r/PR10):** a confirmed match wins over any flag (`coverage: "bill_matched"`); passing
`billMatchedCounts: false` previews that — the row stops counting toward household spend and its allowance bucket,
because the bill is already counted in the bills plan.

**Pinned:**
- `spendingFactsClassifierParity.integration.test.ts` — `STATE FARM AUTO`, $142.17, matched: today counts it;
  `billMatchedCounts: false` removes exactly $142.17.
- `budgetActuals.test.ts` — a matched, weekly-flagged $88.40 row: today buckets it under "weekly"; the forward mode
  buckets it nowhere; the delta is pinned at 8840 cents.

### Difference 2 — reimbursable *and* flagged (independent of bill-matching)

**Today:** both `classifyOutflow` (Spending) and `aggregateBudgetMonth`'s own rule (Budget) gate on `!reimbursable`
**before** ever looking at a flag — a reimbursable row is excluded outright, whatever flag it also carries.

**The classifier:** the precedence specified for `classifyMovement` puts the allowance flags (steps 3-5) **ahead of**
`reimbursable` (step 6) — so a row that is both reimbursable and flagged reads as its flag's coverage, always, not
only in a "forward" mode. This was found by the parity tests, not anticipated going in; it is real and unconditional
for as long as `classifyMovement`'s coverage decides the figure.

**Pinned:**
- `spendingFactsClassifierParity.integration.test.ts` — `URGENT CARE COPAY`, $35.00, reimbursable + weekly-flagged:
  today's `householdSpend.total` is $0 for the range; the classifier counts $35.00.
- `budgetActuals.test.ts` — the same shape at $25.00: today's `aggregateBudgetMonth` bucket rows are `[]`; the
  classifier's are `[{bucket:"weekly", spend:"25.00", ...}]`.

Whoever builds PR8r/PR10 should decide, with the owner, whether difference 2 is the intended behavior (a person did
mark this "pay me back", but also asked it come out of this week's allowance — arguably both should be able to be
true) or whether the spec should gate `reimbursable` ahead of the flags too. Nothing here forces either answer; it is
raised so the choice is made on purpose rather than discovered in production.

## What must not change

- `classifyOutflow`, `isRealSpend`, `isRealIncome`, `spendAmount` (`lib/avalanche-core/src/spendingRule.ts`) — the
  core spending rule three other PRs and this one both build on. `classifyMovement` calls it with
  `reimbursableIsSpend: true`; it does not alter its behavior for any other caller.
- `classifyCashRows`/`isBankRow` (`cashRows.ts`) — `classifyMovement`'s `checking` timing calls `isBankRow` directly;
  it does not fork or approximate the bank-row identity.
- `computeWeeklyPayoff`'s output shape and values (`amexAnchor.ts`) — the cadence extraction must stay a move, never
  a recalculation. If a future change to card discovery is needed, change `amexCardCadence.ts` once; both
  `computeWeeklyPayoff` and `moneyContext.ts` pick it up.
- `buildSpendingFacts`'s and `aggregateBudgetMonth`'s own returned figures — the new `classifierHouseholdSpend`/
  `classifierAllowanceRows` functions are additive exports beside them, not replacements.
- `CARD_LEDGER_SOURCES` (`householdMoney.ts`) and `AMEX_TXN_SOURCES` (`amexAnchor.ts`) must keep the same two values
  — `moneyContext.test.ts` pins them equal because avalanche-core cannot import from api-server to check this itself.

## Verification

- `pnpm run typecheck` — clean (singleton deps, `tsc --build` for the libs, then every `artifacts/**` package).
- Web tests, `TZ=UTC`: 139 files / 1148 passed, 3 skipped. `TZ=America/Chicago`: 139 files / 1149 passed, 2 skipped.
- API tests, `CI=true TZ=UTC`, full suite: 150 files / 2019 passed, 7 todo — includes the golden and spine-parity
  tests, and the 9 Amex test files (40 tests) confirming the cadence extraction is behavior-preserving.
- `pnpm run build && node scripts/check-entry-graph.mjs` — landing route 574.4 KB raw / budget 580 KB; no recharts on
  the open path; react-dom confined to `vendor-react-*`.
- No codegen run: no route, no response shape, and no `lib/api-spec/openapi.yaml` changed.

## How PR8r/PR10 will use this

1. Call `loadMoneyContext(householdId, range)` once per request in `routes/spine.ts`, `routes/reports.ts` (via
   `buildSpendingFacts`), and `routes/budget.ts` instead of each of those files' own ad hoc reads.
2. Switch `buildSpendingFacts`'s `householdSpend`/`realSpend` accumulation to call `classifyMovement` per row and use
   `classifierHouseholdSpend`'s `counts` predicate (with `billMatchedCounts: false`, decision 12's forward rule) —
   this is the point where difference 1 above becomes real and visible, and the point at which the owner's decision
   on difference 2 needs to be locked in.
3. Switch `aggregateBudgetMonth`'s bucket assignment to `classifierAllowanceRows` the same way, so the allowance card
   and Spending's household figure move together, from one classifier, instead of two independently-evolving rules.
4. Read `everydayPlan` server-side (`moneyContext.ts`'s settings) wherever the allowance cap is computed today, so
   the server and `allowances.tsx`/`command-center.tsx` can never quote two different caps for the same week.
5. Surface `timing` (checking vs. card vs. none) wherever a figure needs to know whether a row already moved cash —
   this PR does not consume `timing` anywhere yet; it exists for the bank-balance/forecast side of decision 7 that
   PR10 is expected to touch.

## Open questions

- Difference 2 (reimbursable + flagged) needs an owner call before PR8r ships: keep the classifier's literal
  precedence (a flag always wins), or add a `reimbursable`-first carve-out matching today's rule. Either is a
  one-line change to `classifyMovement`'s step ordering; this PR takes no position.
- `moneyContext.ts`'s `checkingAccountExternalId` resolution reuses `resolveLedgerAccounts` with `account: undefined`
  (always the household's snapshot account). A household mid-way through a Chase account switch, or one that has
  never linked a bank account, resolves to `null` — every row's `timing` then reads `card` or `none`, never
  `checking`. This matches `isBankRow`'s own null-anchor behavior; it hasn't been exercised against a real multi-
  account household.
- "Unresolved plans" (decision 7's second half — forward-looking bill/debt-payment plan items not yet matched to a
  transaction) are not read anywhere in this PR. `classifyMovement` classifies transactions; a forecast plan item has
  no row to classify yet. PR10 will need its own answer for how a plan slots into the same model.
