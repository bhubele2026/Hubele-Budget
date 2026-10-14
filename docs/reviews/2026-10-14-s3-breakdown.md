# S3: "Why are we over?" — the period breakdown

Branch `fix/s3-breakdown`, from `fix/nav-review` (e14cc3f9).

- **Implemented:** all five items of the brief, on the branch.
- **Tested:** new unit + integration tests; full API suite; web suite; build + entry graph.
- **Deployed:** no. **Enabled:** nothing (no AI, SMS, Plaid or setting changed).

## The owner's question
- "Why are we over weekly and monthly?"
- **Week** = the weekly allowance: weekly-flagged + unfiled spending (the cap's pool).
- **Month** = the monthly allowance: monthly-flagged spending, calendar month (owner's decision).
- The household budget month (`GET /budget/months/:m`) is not in this endpoint.

## What changed

### 1. `rule` on `MovementClassification` (avalanche-core)
- `classifyMovement(row, ctx, { explain: true })` adds `rule` and `outflowRule`.
- Rules: transfer · bank_noise · debt_payment · card_payment · excluded_category · income_category · income · inflow_other · bill_match_confirmed · bill_match_tier2 · reimbursable · unplanned_flag · monthly_flag · weekly_flag · unfiled.
- A refund carries the placement rule of what it nets (its coverage, `refund`, already says it is money back).
- Without `explain` the answer is unchanged, byte for byte.

### 2. One classified read
- `loadAllowanceWindow` (moneyContext.ts) = `loadMoneyContext` + `loadMovementRows` + `classifyMovement`.
- Used by the money position's week, the Monthly Spend hook and the breakdown.
- `loadPositionInputs` keeps the week's rows on the read: `weekMovement` (`{row, m}`), `money`, `allowancePlans`.
- `inputs.weekRows` is `allowanceRowOf` over those same entries.
- `loadMovementRows` also selects `pending` (decides nothing).

### 3. Shared helpers (one call each)
- `allowanceSpentCents(rows, weekly|monthly)` — the hook's spent and the breakdown's actual.
- `allowanceRemainingCents(cap, adj, spent)` — `computePosition`'s `remainingWeek` and the breakdown's `remaining`.
- `weeklyCapCents` / `monthlyCapCents` — the $0-is-no-cap rule (position this week, next week, breakdown).
- `allowancePlanInEffect` is now generic (type only), so the plan row's id comes back.

### 4. `periodBreakdown` (avalanche-core, pure)
- `categories[]`: rows filed to the plan, by category; amount, shareBp, count, usual, aboveUsual, rows (largest first), truncated.
- `needsClassification`: unfiled rows, category as an attribute; `countsAgainstPlan` true for a week.
- `refundFloorAdjustment` = actual − Σ groups (≥ 0; throws if negative).
- Σ categories + needsClassification + floor = actual, to the cent.
- Split rows: one entry per part; each keeps the parent's account and coverage; parts sum to the parent; else the row counts whole.
- `usual`: ways-back `medianCents` over 8 prior weeks / 3 prior months; a period with none is 0; periods before tracking are left out; none left → null.

### 5. `GET /api/money/period-breakdown`
- `period=week|month&start=YYYY-MM-DD[&account=<plaid_accounts.id>][&rowsPerGroup=1..50, default 10]`.
- Current week: `loadPositionInputs` only — actual = `spentWeekDiscretionary`, remaining = `remainingWeek` by construction.
- Past week: same building blocks (window read, ledger's tier-2 pairs, `everydayPlanFromRows(start)`, `readWeekAdjustments`).
- Month: `monthlyCapCents(everydayPlanFromRows(monthStart))` vs `allowanceSpentCents(…, "monthly")` over the month.
- `account=`: that account's rows (`netAccountOf`); exact because every figure nets per account. Plan stays household (`planScope`).
- Not set → `plan.status: not_set`, amount/remaining/over/withinPlan null. Quiet week with a plan → `actual: "0.00"`.
- Refused (400): not a Sunday / not the 1st, future period, period ending before 2026-05-01, bad account id, bad rowsPerGroup. Foreign account: 404.
- `limitations[]`: `tier2_pairs_only_since:<first of last month>` (past periods), `tracking_start:2026-05-01`, `usual_periods:<n>`.

### 6. Spine `monthAllowance {plan, actual, status}`
- `readMonthAllowance` — the same `readPeriod` + `allowanceSpentCents` as the endpoint; handed the spine's own cash read.
- Status: not_set · within · over. No debt balance, credit or limit (landing-law tests still pass).

## Files
- `lib/avalanche-core/src/householdMoney.ts` — rule, helpers.
- `lib/avalanche-core/src/periodBreakdown.ts` — new, pure.
- `lib/avalanche-core/src/availableToSpend.ts` — `remainingWeek` via `allowanceRemainingCents`.
- `lib/avalanche-core/src/index.ts` — exports.
- `artifacts/api-server/src/lib/moneyContext.ts` — `loadAllowanceWindow`, `pending`.
- `artifacts/api-server/src/lib/moneyPosition.ts` — `weekMovement`, `money`, `allowancePlans`; cap helper.
- `artifacts/api-server/src/lib/everydayHooks.ts` — window + `allowanceSpentCents`; `HookPayoff.spentCents`.
- `artifacts/api-server/src/lib/periodBreakdown.ts` — new: read, enrich, view.
- `artifacts/api-server/src/routes/money.ts`, `routes/spine.ts`.
- `lib/api-spec/openapi.yaml` + generated `lib/api-zod`, `lib/api-client-react`.

## Figures that move
- **None.** Position, spine, forecast/hook, budget and spending facts read the same.
- Proof: every existing API test unchanged and green (full suite below).
- New only: the endpoint, `spine.monthAllowance`, `HookPayoff.spentCents` (internal; read by no figure).

## Tests added
- `src/lib/periodBreakdown.test.ts` (28): rule per row; `explain` changes nothing (6,000 seeded rows); grouping; refund floor; split; usual; 300 seeded weeks = `computePosition` to the cent.
- `src/__tests__/periodBreakdown.integration.test.ts` (30): worked-by-hand households A–E.
  - week: actual = position spent; remaining = position = spine; beside = position + spine.spentWeek
  - month: actual = the hook's spent (`loadHookPayoffs`); spine.monthAllowance = endpoint
  - pending→posted once; split parts; Amex purchase in, checking-side Amex payment out
  - Sat 23:30 CT (Sun UTC) stays in the old week and month; Oct 31 → Nov 1
  - `account=` Σ = household; refund floor said; not set ≠ 0; refusals
- `spineParity.integration.test.ts` (+2): monthAllowance = endpoint; week breakdown = position = spine.

## Sample (fixture household A, Wed 2026-10-07)
- `GET /money/period-breakdown?period=week&start=2026-10-04`, then the month's headline.
- Ids cut to 8 characters; lists trimmed where marked. Regenerate: `S3_PRINT_SAMPLE=<file>` on the integration test.

```json
{
  "week": {
    "period": "week",
    "basis": "weekly_allowance",
    "start": "2026-10-04",
    "end": "2026-10-10",
    "isCurrent": true,
    "timezone": "America/Chicago",
    "scope": {"kind": "household", "id": null, "institution": null, "name": null, "mask": null},
    "planScope": "household",
    "plan": {"status": "set", "amount": "300.00", "source": "plan", "planId": "f707f40a…", "effectiveFrom": "2026-05-01"},
    "carryOver": null,
    "actual": "324.50",
    "remaining": "-24.50",
    "over": "24.50",
    "withinPlan": false,
    "categories": [
      {
        "categoryId": "a15ca17f…",
        "name": "Groceries",
        "amount": "156.60",
        "shareBp": 4826,
        "count": 3,
        "usual": "45.00",
        "aboveUsual": "111.60",
        "rows": [
          {
            "id": "9f7a158f…",
            "date": "2026-10-05",
            "displayName": "H-E-B",
            "amount": "96.60",
            "account": {"id": "b8841183…", "institution": "American Express", "name": "Amex Platinum", "mask": "1001"},
            "pending": false,
            "category": {"id": "a15ca17f…", "name": "Groceries"},
            "reason": {"coverage": "allowance_weekly", "nets": null, "rule": "weekly_flag"},
            "splitPart": null
          },
          "… 2 more rows (sorted by amount)"
        ],
        "truncated": false
      },
      {
        "categoryId": "0aca7594…",
        "name": "Gas",
        "amount": "92.40",
        "shareBp": 2847,
        "count": 2,
        "usual": "0.00",
        "aboveUsual": "92.40",
        "rows": [
          {
            "id": "76f57c2e…",
            "date": "2026-10-07",
            "displayName": "Shell Oil 57442",
            "amount": "47.40",
            "account": {"id": "416d01c1…", "institution": "Chase", "name": "Chase Checking", "mask": "5526"},
            "pending": false,
            "category": {"id": "0aca7594…", "name": "Gas"},
            "reason": {"coverage": "allowance_weekly", "nets": null, "rule": "weekly_flag"},
            "splitPart": null
          },
          "… 1 more rows (sorted by amount)"
        ],
        "truncated": false
      },
      {
        "categoryId": "f9dd85d2…",
        "name": "Home",
        "amount": "50.00",
        "shareBp": 1541,
        "count": 1,
        "usual": "0.00",
        "aboveUsual": "50.00",
        "rows": [
          {
            "id": "8b47f5a7…",
            "date": "2026-10-06",
            "displayName": "Target",
            "amount": "50.00",
            "account": {"id": "eb728854…", "institution": "American Express", "name": "Amex Blue", "mask": "2002"},
            "pending": false,
            "category": {"id": "f9dd85d2…", "name": "Home"},
            "reason": {"coverage": "allowance_weekly", "nets": null, "rule": "weekly_flag"},
            "splitPart": {"index": 0, "count": 2, "parentAmount": "130.00"}
          }
        ],
        "truncated": false
      }
    ],
    "needsClassification": {
      "amount": "25.50",
      "count": 1,
      "rows": [
        {
          "id": "b10475e4…",
          "date": "2026-10-07",
          "displayName": "Taco Shop 22",
          "amount": "25.50",
          "account": {"id": "b8841183…", "institution": "American Express", "name": "Amex Platinum", "mask": "1001"},
          "pending": false,
          "category": {"id": "38b4d017…", "name": "Dining"},
          "reason": {"coverage": "needs_classification", "nets": null, "rule": "unfiled"},
          "splitPart": null
        }
      ],
      "truncated": false,
      "countsAgainstPlan": true
    },
    "refundFloorAdjustment": "0.00",
    "beside": {"unplanned": "85.00", "weekly": null, "monthly": "30.00", "billMatched": "0.00", "reimbursable": "0.00", "householdSpend": "439.50"},
    "limitations": []
  },
  "month (headline)": {
    "period": "month",
    "basis": "monthly_allowance",
    "start": "2026-10-01",
    "end": "2026-10-31",
    "plan": {"status": "set", "amount": "400.00", "source": "plan", "planId": "8b9d46b9…", "effectiveFrom": "2026-05-01"},
    "actual": "440.00",
    "remaining": "-40.00",
    "over": "40.00",
    "withinPlan": false,
    "refundFloorAdjustment": "0.00",
    "categories": [
      {"name": "Home", "amount": "380.00", "count": 3, "usual": "100.00", "aboveUsual": "280.00"},
      {"name": "Health", "amount": "60.00", "count": 1, "usual": "0.00", "aboveUsual": "60.00"}
    ],
    "beside": {"unplanned": "85.00", "weekly": "324.50", "monthly": null, "billMatched": "0.00", "reimbursable": "0.00", "householdSpend": "849.50"}
  }
}
```

## Deviations from the brief (code wins, intent kept)
- `rule` is opt-in (`explain`): two existing tests deep-equal the classification; opt-in keeps them untouched. Every window read asks for it.
- Display name, account identity and split parts are looked up by the same row ids in the breakdown, not on the position read — keeps three extra queries off the spine's path.
- `scope` is one flat object (`kind` + nullable fields), not a union — simpler codegen.
- Extra fields: `reason.nets`, `account.id`, `needsClassification.countsAgainstPlan`.
- `beside` = unplanned · weekly|null · monthly|null · billMatched · reimbursable · householdSpend|null (null = it is `actual`, or one account).
- Month: unfiled rows never count against the monthly plan, so `needsClassification` is empty for a month (`beside.weekly` holds the month's weekly pool).
- The spine's `position` has no weekly spent; parity is asserted on `remainingWeek` and `/money/position.spentWeekDiscretionary`.

## Open / doubtful
- **Month cap vs the hook:** the breakdown reads the monthly plan row only (not set without one). The hook still falls back to `settings.monthly_allowance_amount` when no row is in effect. Same spent; the cap can differ for such a household. S2 (decision 5) aligns the hook.
- **Plan in effect for a month** uses `everydayPlanFromRows(monthStart)` as the brief says: a row dated by the first Saturday of the month governs the whole month (existing rule).
- **account=** is one `plaid_accounts` row (no mask-twin merge). Rows with no linked account (manual, workbook Amex) are in no account scope.
- **S1 overlap:** S1 also plans `rule` on `MovementClassification`. If S1 lands separately, keep one list (`MOVEMENT_RULES`).
- **usual** nets refunds per category (signed); ways-back trims count purchases only (S6 plans that fix).
- `tier2_pairs_only_since` is the first of last month (the ledger's plan expansion floor), computed here, not read off the ledger.
- Endpoint cost: one forecast ledger per request (as `/money/position`), plus history, splits, accounts, aliases and spending facts.

## Gates
- `pnpm run typecheck`: pass (libs, api-server, h2budget, e2e, scripts).
- API, full suite (`DATABASE_URL=…/h2budget_test_s3_breakdown`): **255 files, 2,801 passed, 7 todo, 0 failed**.
- S3 + parity files under `TZ=America/Chicago` and `TZ=UTC`: 5 files, 106 passed each.
- Web (`CI=true pnpm --filter h2budget exec vitest run`):
  - `TZ=America/Chicago`: 217 files, 2,072 passed, 2 skipped.
  - `TZ=UTC`: 217 files, 2,071 passed, 3 skipped.
- `pnpm run build && node scripts/check-entry-graph.mjs`: OK. Landing **620.5 KB** (budget 622) — identical to the base e14cc3f9 build (entry chunk 302,623 bytes both). No S3 code in any web chunk.
- Codegen: a second run leaves git clean; only the generated files for the new schemas and `Spine.monthAllowance` changed.
