# PR6 — Overdue bills are assumed unpaid, and never dropped silently

Codex work-order point **5** (overdue bills and recurrence), plan PR6. Built on PR5a ("probably paid"), then merged with
`main` once PR5a landed (`9923add`: PR5a, PR13, PR4e follow-ups). Plan: `~/.claude/plans/h2-budget-work-serene-pebble.md`.

| Commit | What it does |
|---|---|
| `15f5c9b` | The ledger's overdue rule, the occurrence key, `remapOrphanResolutions`, the one-time archive rule and `isPastOneTime`. |
| `3cf38a2` | Merge of PR5a's second look (`bcc3ea9`). `forecastLedger.ts` auto-merged. |
| `dbf680a` | `CashSignal` fields and lists (OpenAPI + codegen); the Past-due card and tooltip send the occurrence key; tests. |
| `fe34b0e` | Merge of `origin/main` (`9923add`). Only generated `.d.ts.map` files conflicted; regenerated. |
| `074661f` | Golden re-recorded; the cash-signal tests clean up avalanche settings. |
| _this note_ | Review note; one test title corrected. |

## The problem

**An unpaid bill vanished from the forecast after any Sync.**
- The pre-snapshot rule (#666) dropped every plan dated before the bank snapshot, on the theory that the balance
  already held it. The one exception (#688) kept an expense dated the day before.
- A Sync stamps the snapshot "now". So after every Sync, every unresolved bill due before today, except yesterday's,
  left the curve — paid or not. The curve overstated cash by those bills.
- **Example:** Rent $1,500 due the 1st, unpaid, snapshot refreshed on the 8th → no dip anywhere.
- #666 existed to stop phantoms: bills a bank row had paid without a match (Mortgage/HELOC). PR5a's `offCurve` pair is
  now that evidence, so the date rule can go.

**Four related bugs, all hidden until now by #666:**
- **Moved-bill key.** For a moved bill, `events[].originalDate` is the moved-to date. The Past-due card and the chart
  tooltip sent it as the occurrence, but resolutions are keyed on the date the bill was moved FROM. So Mark missed /
  Skip / match on a moved-then-overdue bill wrote a key the curve never read, and nothing moved.
- **One-time bills.** `archiveExpiredOneTime` set a one-time bill inactive the day after its date. An unpaid one-time
  bill disappeared on the next page load, and a moved one could not be recovered.
- **Schedule edits.** `PATCH /recurring-items/:id` overwrites the schedule and orphans resolutions. Due day 14 → 20
  after May was matched leaves the match on the 14th and a phantom unpaid 20th.
- **Pre-anchor phantoms.** Weekly/biweekly expansion walks back past the anchor, semimonthly ignores it, and debt
  minimums have no start. Each produces "overdue" occurrences from before the item existed.

## What changed

### The plans loop (`buildForecastLedger`)

`bankToday` is computed before the loop and does not move. For each plan occurrence, in order:
1. **Resolved** (matched / skipped / missed / dismissed) → off the curve. A `partial` keeps its remainder.
2. **Paid by an `offCurve` pair** (PR5a) → off the curve.
3. **Due on or before today** (or the snapshot day, when that is later) and still unresolved:
   - **expense due in [today−14, today)** → the next business day, tagged **`overdue_assumed_unpaid`**;
   - **expense due today** → the next business day, **`due_today_not_posted`**, so day 0 still equals the bank;
   - **expense older than 14 days** (#803's floor) → **`overdueOutsideForecast[]`**, off the curve;
   - **income due before today** → **`incomeNotArrived[]`** (tag `income_not_arrived`), off the curve. Income due
     today stays off the curve, as before.
4. **Otherwise** → on its own (moved-to) date.

- **A suggestion does not count as paid.** A plan whose only pair is not `offCurve` still drags. An unconfirmed guess
  never overstates cash. The web can join the suggestion to the dragged plan or listed entry by `planKey`
  (`events[].occurrenceKey`, `overdueOutsideForecast[].planKey`, `incomeNotArrived[].planKey`).
- **Never overdue from before the item existed.** An occurrence dated before the item's start is skipped in step 3,
  and is not a matching candidate either:
  - a recurring item starts on its anchor date, else its created day;
  - a debt minimum starts on the debt's created day;
  - the Avalanche extra has no start.
- **The lists are bounded** by the ledger's expansion start (the first of last month) and by the item's start.
- **The #666 drop and the #688 exception are gone** — except for weekly-cadence expenses (below).

### ⚠️ Weekly-cadence expenses keep the old rule until PR8

- **`keepsPreSnapshotRule(item, amount)`**: an expense whose item is `weekly` or `biweekly` keeps the pre-PR6 #666/#688
  rule and the drag exactly as on the base, tagged `dragged_past_due`. It is never dragged as overdue and never listed.
- **Why:** the Weekly Spend reserve is a plain weekly bill that no bank row ever pays. The overdue rule would drag up to
  two weeks of it ($450 × 2 in the seed) onto one day.
- One named predicate, so PR8 can delete it when Weekly/Monthly Spend become Amex payoff events.
- Income of every cadence gets the new rule.

### API (`CashSignal`, OpenAPI + codegen)

- **`events[]`** gains:
  - `assumption` (nullable): `overdue_assumed_unpaid`, `due_today_not_posted`, `dragged_past_due` or
    `pre_window_on_first_day`;
  - `occurrenceKey` (`<itemId>|<occurrenceDate>`);
  - `occurrenceDate` — the resolution key date, the ORIGINAL occurrence date, never the moved-to date.
  - `computeCashSignal` now passes `assumption` through; before, it dropped it.
- **New `overdueOutsideForecast[]` and `incomeNotArrived[]`**, sorted by due date. Each entry: `planKey`, `itemId`,
  `occurrenceDate`, `dueDate` (after any move), `amount` (signed; a partial lists its remainder), `label`,
  `daysOverdue`.
- `events[]` stays expense-only.

### The moved-bill key

- **Ledger:** every plan carries `occurrenceDate`. `originalDate` keeps its meaning (the date it was due after any
  move), so the "Due …" text and the test ids do not change.
- **Web:** `lib/forecastPastDue.ts` holds the card's and tooltip's builders, moved out of `pages/forecast.tsx`
  unchanged apart from the key. The card's Mark missed and "Mark matched to…", its Skip, and the tooltip's Mark missed
  now send `occurrenceDate`.
  - Edits to `pages/forecast.tsx` and `ProjectedBalanceChart.tsx` are limited to those call sites.
- **Resolutions the old web already wrote:** a matched / skipped / missed / dismissed resolution on a moved bill's
  moved-to date still closes that bill (the register already read it that way), unless that date is an occurrence of
  the item in its own right.

### One-time bills (`archiveExpiredOneTime`)

- **Chosen bound: 60 days.** An unresolved one-time bill stays active while its due date (after any move) is within the
  last 60 days, or still ahead. So it can drag (≤ 14 days), be listed (older), or be matched, and a moved one is still
  recovered.
  - "Resolved" = matched, skipped, missed or dismissed, on its occurrence or on its moved-to date.
  - `partial` is not resolved: a remainder may be owed.
- **Nothing else moves.** Every reader that counted only active bills now treats a one-time bill dated before today as
  archived, exactly as before PR6 (`isPastOneTime`):
  - the Budget page plan (`routes/budget.ts`, both expansions);
  - the auto-bills category heal and the income category sync;
  - the Bills totals and active count (`billsSummary`);
  - a debt's linked bill (`buildDebtMinSchedule`, the ledger, the `/forecast` bundle);
  - the Reports → Cash flow run-rate (`CashFlowPage.tsx`).

### Schedule edits (read-only, `lib/resolutionRemap.ts`)

- **At read time, a resolution whose date is not an occurrence of its item maps to the item's occurrence in the same
  period.** The period is:
  - the same calendar month for monthly, quarterly, annual and debt minimums;
  - the nearest occurrence within half a period for weekly (3 days), biweekly (7) and semimonthly (7).
- **Conditions:**
  - it maps only when that occurrence has no resolution of its own and no earlier orphan claimed it;
  - every resolution at the orphaned date moves together, "Not this" (`not_match`) included;
  - an exact tie maps nowhere; one-time and inactive items never map.
- **Nothing is written.** Both the ledger and the `/forecast` bundle apply it, through
  `resolutionScheduleLookup`, so the web register and the curve agree. `forecastMatch.ts` needed no change.

### Recurrence

- **Monthly day 31:** Feb 28, Mar 31, Apr 30 is now a test. Expansion was already right.
- **Expansion is unchanged**, so the web copy of `expandItem` needed no change.
- Pre-anchor occurrences leave the overdue scope as above; future pre-anchor occurrences still project as before.

## Figures that should move

- **The forecast curve, low point, ending balance and max safe extra: DOWN** by every unresolved expense due in the
  last 14 days that no bank row confidently paid, and that the #666 drop hid.
  - **Golden, full household** (snapshot 05-08, today 05-14): Rent due 05-01 (−1,500.00) and the Avalanche extra due
    04-30 (−150.00) now land on 05-15.

    | Entry | Figure | Before | After |
    |---|---|---|---|
    | default window | low point (05-15) | 2,690.00 | 1,040.00 |
    | default window | ending | 6,314.00 | 4,664.00 |
    | default window | projected expenses | 2,471.00 | 4,121.00 |
    | default window | max safe extra | 2,190.00 | 540.00 |
    | window after the anchor | ending | 4,762.00 | 3,112.00 |
    | window after today | starting balance | 2,690.00 | 1,040.00 |
    | PR4b snapshot rule | low point | 3,035.00 | 1,385.00 |
    | PR4b snapshot rule | ending | 6,659.00 | 5,009.00 |
    | snapshot dated after today | low point | 3,000.00 (no date) | 1,255.00 (05-15) |

    With the snapshot dated after today, Phone 05-12 drags too, for −1,745.00.
- **These will drag until someone acts, by design:**
  - **Debt minimums paid by a larger card payment.** The pair is only a suggestion (not `offCurve`), so the minimum
    drags until confirmed.
  - **Last month's Avalanche extra payment.** No bank row names it, so it drags for up to 14 days after month end
    unless it is matched, skipped or marked missed, and is then listed.
  - **PR5a's second look.** Its stricter `offCurve` means fewer overdue plans get an `offCurve` pair, so more of them
    drag with `overdue_assumed_unpaid`. That errs low, as intended.
- **The curve moves UP** in these cases:
  - a bill whose due day was edited after it was matched no longer has an unpaid twin in that month;
  - a Mark missed / Skip / match on a moved bill now takes it off the curve, including one the old card already wrote
    on the moved-to date.
- **New and visible:**
  - `overdueOutsideForecast`: golden full household lists 7 April occurrences, 19–43 days old;
  - `incomeNotArrived`: the golden 05-08 paycheck;
  - one-time bills up to 60 days overdue stay in the register.
- **Unchanged:**
  - day 0 and cash today (`bankToday` is identical in all 11 golden entries);
  - income on the curve;
  - weekly and biweekly expenses;
  - plans due after today;
  - the golden entries whose past-due plans already dragged (edge paths, both no-snapshot entries, time-only /
    balance-only), to the cent;
  - `matches` in every golden entry.
- **Not measured:** how much the live household's curve moves. That needs a read-only GET in Brad's signed-in browser,
  which this build did not do.

## Must not change

- `bankToday`, the spine bank balance and spine parity (the parity test passes; the low point follows the cash signal).
- The review count (no resolution is written) and spending.
- The Budget page `plannedTotal` / `planBySource` (a new test: a kept one-time bill changes neither).
- Server auto-match stays off.
- No DDL, no new dependencies (`pnpm-lock.yaml` unchanged); landing bundle 572.5 KB of 580.
- Send-to-Forecast single flow.

## Residuals

- **Weekly-cadence expenses** keep the pre-snapshot drop and its weekend double lump until PR8 turns Weekly/Monthly
  Spend into Amex payoff events.
- **Silent beyond the expansion start.** An unresolved occurrence older than the first of last month is not listed
  (28–61 days back, depending on the day of the month).
- **Back-dated anchors.** An item created recently with an old anchor date can list occurrences back to that bound.
  The start is the anchor when one is set, per the brief.
- **The Avalanche extra has no start date.** Its only bound is the expansion start.
- **Income due today** is off the curve and not listed (unchanged); only income due before today is listed.
- **A snapshot dated after today** (clock skew) drags plans between today and the snapshot day as
  `due_today_not_posted` (the drag cutoff is still max(snapshot, today)).
- **One-time bills already archived before this deploys stay archived.** An inactive one-time bill cannot be told apart
  from one paused on purpose.
- **A kept one-time bill shows as active** in the Bills page list and in the web's debt payoff-badge name matching.
  No total counts it.
- **Schedule-edit mapping:**
  - one-time bills never map: editing a one-time bill's date orphans its resolution;
  - ties never map;
  - the stored rows keep their old dates;
  - the Bills "actual paid" (#70) still reads stored dates, so a weekly edit across a month boundary can put a paid
    amount in the other month.
- **Paychecks.** A paycheck paired by a named deposit, but held back by PR5a's "earlier unpaid occurrence" check, stays
  listed as not arrived.
- **The web shows no tags or lists yet.** The tooltip still derives "dragged" from `originalDate !== date`, so it shows
  neither `assumption` nor the two lists.
- **Playwright e2e not run:** `forecast-dragging-plans-summary`, `forecast-tooltip-mark-missed`,
  `forecast-chart-day0-bank-balance`. Test ids are unchanged, but their fixtures may seed pre-snapshot plans that used
  to drop.

## Tests

- **`cashSignal.integration.test.ts` (11 changed):**
  - **Replaced** the three #666/#688 tests. Each replacement is stricter: it pins where the bill lands and its tag
    instead of "not on these dates".
    - "(#666) pre-snapshot pending plans are dropped" → both unpaid bills land on 05-15: 1,220.87, `overdue_assumed_unpaid`.
    - "(#666/#681) strictly pre-snapshot plans drop" → the expense lands on 05-15 (3,805.27, the #666 figure, now day 1
      with day 0 at 4,922.56); the income is listed.
    - "(#688) plans dated 2+ days before snapshot stay dropped" → **the paid/unpaid pair**:
      - **paid:** a named row ("LAKEVIEW MORTGAGE PMT") → off the curve, 4,871.20 flat, a high `offCurve` match;
      - **unpaid:** the same bill with no row → 3,371.20 on 05-15, `overdue_assumed_unpaid`.
  - **Updated, with each flip explained:**
    - #667 debt minimum → 05-10 drags (4,884.56), and 04-10 is listed (34 days).
    - #667 Avalanche extra → 04-30 drags (4,722.56), and the 04-25 minimum is listed (19 days).
    - #688 yesterday's bill → also pins the tag and key.
    - The snapshot-day test → pins day 1 (1,258.87). Its old title said "dropped"; the plan always dragged.
    - #681 income → listed.
    - #667/#681 boundary → `due_today_not_posted`.
  - **Fixture precision, not weakening:**
    - the two #687/#681 synthetic-debt tests pin the debt's `createdAt` before its minimum. The database default is the
      wall clock, which is after the pinned "today".
    - `cleanup()` now deletes `avalanche_settings`. A $200 extra leaked into later tests, unseen while #666 dropped it.
  - #803 boundaries and #681/#751 tests pass unchanged.
- **`cashSignalOverdue.integration.test.ts` (14):**
  - today−15 listed and today−14 dragging (975.00);
  - today's bill (day 0 1,000.00, day 1 905.00);
  - a skipped occurrence;
  - a low suggestion that still drags (940.00);
  - income not arrived (listed 36 and 6 days; 06-08 3,000.00);
  - pre-start occurrences: semimonthly, a debt added 05-11, a weekly income (ending 1,265.00);
  - a bill moved beyond the window, and one moved into it (955.00; 07-01 655.00);
  - Mark missed with the occurrence key (920.00 → 1,000.00);
  - the old moved-to-date key still closing (1,000.00), but not on the bill's own occurrence (950.00);
  - due day 14 → 20 after a match: no phantom on the curve or in the register, stored rows unchanged;
  - one-time bills after a page load: Plumber kept (750.00), a moved one recovered (625.00), a 74-day and a resolved
    one archived, Bills totals 0.00 / 0 active;
  - the weekly exception: a Sunday snapshot with Weekly Spend $300 gives 1,000.00 / 700.00 (05-18) / 400.00 /
    100.00 / −200.00 / −500.00, as on the base, tagged `dragged_past_due`, never listed.
- **`resolutionRemap.test.ts` (11):** monthly 14 → 20; a real occurrence stays; an occupied target; "Not this" moves
  with its bill; the earlier orphan wins; weekly Sat → Mon; biweekly tie; semimonthly; quarterly in and off its month;
  one-time / inactive / unknown; no mutation.
- **`cashSignal.test.ts` (+1):** day 31 → Feb 28, Mar 31, Apr 30.
- **`budgetPlanBySource.integration.test.ts` (+1):** a one-time bill 5 days overdue stays active and leaves
  `planBySource` and its line unchanged.
- **Golden (11 re-recorded):** every event gains the three fields and every entry gains the two lists; the figures
  that moved are listed above.
- **Web `lib/forecastPastDue.test.ts` (5):** the card's line, match and Skip send 05-05, not the moved-to 05-11; so does
  the tooltip; an unmoved bill sends its own date; the fallback for a payload without `occurrenceDate`.

## Failing before

Pre-PR6 source means `9923add`, which contains `f40c4b0`, with PR6's source files swapped back:
- server: `forecastLedger`, `cashSignal`, `billsSummary`, `debtMinSchedule`, `routes/budget`, `routes/forecast`;
- web: `pages/forecast.tsx`, `ProjectedBalanceChart.tsx`, `CashFlowPage.tsx`;
- `resolutionRemap.ts` and `forecastPastDue.ts` removed.

**49 of the 54 new or changed tests fail:**
- **`cashSignal.integration`, 9 of 11:**
  - on a curve figure: the #666 replacement, the income/expense split, the unpaid half of the pair, the #667 debt
    minimum, the #667 Avalanche extra;
  - on the new fields only: #688 yesterday, the paid half of the pair, the boundary, #681 income.
  - Still passing: the snapshot-day test (it always dragged) and the #687 synthetic debt minimum (fixture only).
- **`cashSignalOverdue`, 12 of 14.** Still passing: the weekly figures (as intended) and the old moved-to-date key
  (on the base, #666 hid that bill instead).
- **Golden, 11 of 11.**
- **`budgetPlanBySource`, 1 of 1:** the base archived the bill.
- **`resolutionRemap`, 11 of 11:** no module.
- **Web `forecastPastDue`, 5 of 5:** no module.
- **Day 31, 0 of 1:** expansion was already right.

## Verification

- **Workspace typecheck:** clean.
- **Full API suite (`CI=true`):** **131 files, 1132 pass, 7 todo**. The golden compares clean.
- **Web suite:** **120 files, 938 pass** (+1 file, +5 tests).
- **Build and landing guard:** `pnpm run build` exit 0; `check-entry-graph` OK, **572.5 KB of 580**, unchanged.
- **Codegen:** regenerated after the spec change and again after merging `main`; diff clean.

## Left for later

- **PR8:** delete `keepsPreSnapshotRule` when Weekly/Monthly Spend become Amex payoff events.
- **PR5b:** join suggestions to dragged or listed plans by `planKey`; Confirm / Not this from the Past-due card.
- **PR12:**
  - show `assumption` badges and the two lists ("Assumptions to resolve");
  - the tooltip reads `assumption` instead of `originalDate !== date`;
  - update the three e2e specs.
- **Questions for Brad:**
  - Should editing a one-time bill's date carry its resolution?
  - Should income due today be listed?
