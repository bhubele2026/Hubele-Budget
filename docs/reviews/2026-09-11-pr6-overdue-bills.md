# PR6 — Overdue bills: paid ones stay off the forecast, unpaid ones are never dropped silently

Codex work-order point **5** (overdue bills and recurrence), plan PR6. Built on PR5a ("probably paid"), merged with
`main` at `9923add` (PR5a, PR13) and again at `1144682` (settings fix, PR7b, PR5b). The independent review of `03815aa`
asked for changes; they are below under **Review fixes**. Plan: `~/.claude/plans/h2-budget-work-serene-pebble.md`.

## ⭐ The rule Brad should know

**A bill due before today counts as PAID when the bank shows a payment for it, and UNPAID when it doesn't.**
- **Paid** — any of these, to a checking row dated on or before today:
  - a row the matcher pairs with the bill and nothing else competes for (any confidence: the payee's name, or the same
    amount within max($1, 1%) and 3 days);
  - for a card's minimum: a **card payment** (PR7's rule) that names the card and pays at least the minimum ($40 due,
    $812.40 paid). A store purchase or a loan payment carrying the same word never counts (second review).
- A paid bill is **off the forecast** and listed in `overdueAssumedPaid`. If the row paid less, the **unpaid
  remainder** (over $1) still weighs on the next business day.
- **Unpaid** (no such row, or two rows that can't be told apart): it weighs on the next business day for 14 days, then
  is listed in `overdueOutsideForecast`.
- **⚠️ Accepted risk — at its real width (second review).** For a bill already due, a row counts as paying it when the
  matcher pairs them and nothing else competes. That is wider than "an exact nameless amount":
  - **any row sharing ONE distinctive word of the label**, within the matcher's loose band (max($25, 25%) of the bill),
    dated 10 days before to 14 days after the bill — which includes a different bill from the same payee;
  - or, with no shared word, the same amount within max($1, 1%) and 3 days.

  Measured by the reviewer:

  | Probe | Unpaid bill | Row that hid it | Overstated by |
  |---|---|---|---|
  | X2 | Verizon Wireless $120 | "VERIZON FIOS" −130 | $120 (max safe extra 2,140 instead of 2,020) |
  | X3 | Amazon Prime $14.99 | "AMAZON MKTPL" −18.40 | $14.99 |
  | E6 | Toyota Motor Credit minimum $672.80 | "TOYOTA OF MADISON SERVICE" −712.40 | $672.80 |

  - **Each row hides at most one bill**, and every bill treated as paid is listed in `overdueAssumedPaid`.
  - **Why we keep it (decision A + C):** requiring an exact amount on partial-name pairs would put the HELOC ("Figure
    HELOC", paid "FIGURE LENDING" $1,185.19) back on the curve at $1,130 every month (reviewer's R7: 5,653.33 →
    4,523.33). The alternative — only confident pairs count — made every paid-but-unnamed bill (rent by Zelle, a
    mortgage "LOAN PMT", card minimums) come back as a dip: $3,131.57 of phantom dips in one household.
  - **What the user can see today:**
    - pairs from the main pass are in `matches`, so PR5b's "Suggested" list shows them with "Not this";
    - **card-payment pairs (`card_payment`) and listing-pass pairs (bills before today−45) are NOT in `matches`**, so the
      user cannot see or reject those until PR12.
  - **⏳ Pending Brad's decision:** accept this width (A + C as built), or narrow partial-name pairs for bills already due
    (the HELOC returns as a monthly dip until confirmed)?
- Bills due after today are unchanged: they leave the curve only on PR5a's confident (`offCurve`) pair.
- Weekly and biweekly expenses keep the old rule until PR8 (below).

| Commit | What it does |
|---|---|
| `15f5c9b` | The ledger's overdue rule, the occurrence key, `remapOrphanResolutions`, the one-time archive rule and `isPastOneTime`. |
| `3cf38a2` | Merge of PR5a's second look (`bcc3ea9`). |
| `dbf680a` | `CashSignal` fields and lists (OpenAPI + codegen); the Past-due card and tooltip send the occurrence key; tests. |
| `fe34b0e` | Merge of `origin/main` (`9923add`). Generated maps regenerated. |
| `074661f` | Golden re-recorded; the cash-signal tests clean up avalanche settings. |
| `03815aa` | First review note. |
| `26e1c62` | Merge of `origin/main` (`1144682`: PR5b, PR7b, settings fix). Conflicts resolved (below). |
| `8303cc4` | The evidence rule, the card-payment rule, `overdueAssumedPaid`, the moved-to-date fix, the Avalanche start, the lists' bounds, the dashboard; tests; golden. |
| `66b48ee` | This note, rewritten with the review fixes. |
| `8acc42e` | Second review: a card's minimum is paid only by a real card payment (PR7's rule); tests. |
| _merge_ | Merge of `origin/main` (`11a6f75`, household clock leftovers). `dashboard.ts` imported `householdClock` twice; combined into one import, keeping the household month window and the past one-time exclusion. |
| _this note_ | Second-review additions to this note. |

## The problem

**An unpaid bill vanished from the forecast after any Sync.**
- The pre-snapshot rule (#666) dropped every plan dated before the bank snapshot, on the theory that the balance
  already held it. The one exception (#688) kept an expense dated the day before.
- A Sync stamps the snapshot "now". So after every Sync, every unresolved bill due before today, except yesterday's,
  left the curve — paid or not. The curve overstated cash by the unpaid ones.
- **Example:** Rent $1,500 due the 1st, unpaid, snapshot refreshed on the 8th → no dip anywhere.
- #666 existed to stop phantoms: bills a bank row had paid without a match (Mortgage/HELOC). The review showed that a
  date rule can't be replaced by "confident pairs only"; it needs the evidence rule above.

**Four related bugs, all hidden until now by #666:**
- **Moved-bill key.** For a moved bill, `events[].originalDate` is the moved-to date. The Past-due card and the chart
  tooltip sent it as the occurrence, but resolutions are keyed on the date the bill was moved FROM, so Mark missed /
  Skip / match on a moved-then-overdue bill did nothing.
- **One-time bills.** `archiveExpiredOneTime` set a one-time bill inactive the day after its date, so an unpaid one
  disappeared on the next page load, and a moved one could not be recovered.
- **Schedule edits.** `PATCH /recurring-items/:id` orphans resolutions: due day 14 → 20 after May was matched leaves
  the match on the 14th and a phantom unpaid 20th.
- **Pre-anchor phantoms.** Weekly/biweekly expansion walks back past the anchor, semimonthly ignores it, and debt
  minimums have no start, producing "overdue" occurrences from before the item existed.

## Review fixes (independent review of `03815aa`: REQUEST CHANGES)

| # | Finding | Fix | Tests |
|---|---|---|---|
| H1 | Paid-but-unmatched bills came back as dips: only `offCurve` pairs counted as paid. R1–R7 below; R7 had $3,131.57 of phantom dips. | **The evidence rule.** An overdue plan with a non-ambiguous pair of any confidence is paid for the curve; only the unpaid remainder over $1 drags (`overdue_remainder_assumed_unpaid`). A debt minimum is also paid by a payment naming the card for at least the minimum (`plansPaidInFullByName`, next to the matcher; the matcher and `offCurve` are untouched). Every such plan is listed in the new `overdueAssumedPaid[]`. #666 is not re-added. | R1–R7, a named remainder, an ambiguous pair, helper unit tests |
| H2 | An old-card answer written on a moved-to date was remapped onto next month's bill: April 28 moved to 05-02, a 05-02 "missed" closed May 28. On 05-17 the low read 2,400 instead of 2,100. | `remapOrphanResolutions` never treats a date the item was moved to as an orphan. The ledger and the `/forecast` bundle share the function. | matched, missed and Move on 05-14 and 05-17; register agreement; unit test |
| M1 | The Avalanche extra had no start: setting a $500 extra on 05-05 dragged a 04-30 payment (2,500 → 2,000). | It starts on the household day of `avalanche_settings.updatedAt`. | set today vs set in January |
| M2 | The lists were mostly false positives and unbounded: paychecks that arrived without a name; paid bills older than 14 days, or older than the matching window (Comcast 04-05 listed on 05-31); a January snapshot listed back to January. | Both lists (and `overdueAssumedPaid`) are bounded by the first of last month alone. A plan with a non-ambiguous pair is never listed as unpaid (income: never listed at all). Occurrences older than the matching window (before today−45) get a second pairing pass **for the lists only**; those pairs never reach `matches` or the curve. | January snapshot; Comcast 56 days; R7's income and Hannah's Car |
| LOW | A weekly-cadence item due today is tagged `due_today_not_posted`, not `dragged_past_due` as the note said. | The tag is intended; the note and code comments now say `dragged_past_due` means "due before today". | — |
| LOW | The note's naming of which `cashSignalOverdue` tests pass on the base. | Named exactly below (Failing before). | — |
| LOW | `dashboard.ts` `upcomingBills` included kept past one-time bills. | Excluded in the query (as before PR6). | — |
| LOW | One old-card resolution closes two occurrences of a weekly item moved to the same non-occurrence date. | Disclosed (Residuals). | — |
| — | The golden's "ties" entry changed order between runs. | Found while re-recording: the lists broke same-day ties by a key that embeds a random id. They now sort by due date, then label, then key. The golden passes three runs in a row. | golden |

## Second review (`66b48ee`: REQUEST CHANGES, narrowly)

Both HIGHs were verified fixed on the reviewer's own fixtures (R1–R5 at base, R6 still dragging, HIGH 2 on 05-14 and 05-17,
the bounded lists, day 0 at the bank, the weekly exception, the merge, the golden). One fix was required.

### Required: a card's minimum is paid only by a real card payment

- **Finding (probe E6, today 05-05):** `plansPaidInFullByName` checked sign, window, amount and a shared name word, never
  that the row was a card payment. Each of these minimums was taken off the curve by the wrong row:

  | Minimum | Row that paid it | What the row is |
  |---|---|---|
  | Target RedCard $35 | "TARGET T-2331" −84.12 | a store purchase |
  | Apple Card $25 | "APPLE STORE" −1,299.00 | a store purchase |
  | Capital One $38 | "CAPITAL ONE AUTO CARPAY" −452 | a car-loan payment |

  A refund ("DISCOVER CASHBACK" +40) was already refused (wrong sign).
- **Fix:** the row must also be a card payment by PR7's rule (`isCardPaymentRow`, next to the helper): the user's
  "card payment" flag, Plaid's `LOAN_PAYMENTS_CREDIT_CARD_PAYMENT`, or `matchesCardPaymentPattern`. The name word is
  still required, so a Discover payment never pays a Capital One minimum. The ledger passes each candidate row's flag
  and Plaid category.
- **PR7 was checked first, not widened:** it classifies "TARGET T-2331", "APPLE STORE", "CAPITAL ONE AUTO CARPAY" and
  "DISCOVER CASHBACK" as not card payments, so no loan-word exclusion was needed.
- **Figures (our E6 test: balance 3,000, buffer 500):** with all four minimums unpaid, 05-06 is 2,862.00 and the max safe
  extra 2,362.00. On `66b48ee` the three wrong rows paid their minimums: 2,460.00.
- **R4 stays at base (2,500).** Its statement payments use PR7's issuer phrases. ⚠️ The earlier R4/R7 fixtures used
  "CAPITAL ONE MOBILE PMT", which PR7 does NOT recognise (its phrase is "CAPITAL ONE MOBILE PYMT"); they now use PR7's
  phrase. A real Capital One payment without PR7's phrase now leaves its minimum dragging, unless Plaid's category or the
  user's flag marks it (errs low).

### Also stated at the reviewer's request

- **E4 (errs low):** a `partial` confirmed for $500 of a $1,500 bill, whose rest is paid by a later row, still drags the
  $1,000 remainder. Plans with a partial are excluded from matching, so the later row can't pay the remainder.
- **E2 / E2b (errs low):** $1,500 rent paid by two $750 Zelles: neither row pairs, so the full $1,500 drags until the user
  matches it.
- **R7 figures:** the reviewer's R7 household reads 5,653.33 (max safe extra), not our fixture's 6,000. Variable
  utilities paid under a different name have no pair and drag (MGE 241.00 + Water 101.02), plus a Verizon remainder of
  4.65. That is correct under the rule. With a stale snapshot the reviewer's R7 is 4,753.33 (base 1,968.43).
- **X1 (lists only):** a paycheck that did not arrive can be missing from `incomeNotArrived` when a savings transfer of
  the same amount comes in around its date (it pairs). The curve is unaffected: income that hasn't arrived is never on
  it.
- **A2 (already disclosed):** re-saving the avalanche settings moves the extra's start, which can hide a real unpaid
  month-end extra. Last month's "Avalanche payment" budget line would be a better start signal; no change here.

### The merge with PR5b (`26e1c62`)

- **`routes/forecast.ts`:** PR5b removed the bundle's `not_match`/`partial` filter; PR6's remap is kept in front of the
  remaining filters.
- **`pages/forecast.tsx`:** both intents kept.
  - The Past-due card's line comes from `draggingPlanLine` (the occurrence key), and PR5b's "Partly paid" chip checks
    the occurrence key as well as PR5b's two dates.
  - Skip sends the occurrence key and keeps PR5b's `writeKeyIsPartial` refusal, now asked about that key.
  - `onMarkMissed` and `matchInboxToPlan` merged cleanly and read `originalDate ?? date`, which the card and tooltip
    set to the occurrence key.
- **`ProjectedBalanceChart.tsx`:** PR5b's `lockedPlanKeys` check now also refuses a row whose occurrence key is partly
  paid.

## What changed

### The plans loop (`buildForecastLedger`)

`bankToday` is computed before the loop and does not move. For each plan occurrence, in order:
1. **Resolved** (matched / skipped / missed / dismissed) → off the curve. A `partial` keeps its remainder.
2. **Due after today** (or a weekly-cadence expense): off the curve on an `offCurve` pair (PR5a), as before.
3. **Due on or before today** (or the snapshot day, when that is later) and still unresolved:
   - **paid on evidence** (the rule at the top) → off the curve, listed in **`overdueAssumedPaid[]`**; a remainder over
     $1 drags if due in the last 14 days;
   - **expense due in [today−14, today)** → the next business day, **`overdue_assumed_unpaid`**;
   - **expense due today** → the next business day, **`due_today_not_posted`**, so day 0 still equals the bank;
   - **expense older than 14 days** (#803's floor) → **`overdueOutsideForecast[]`**, off the curve;
   - **income due before today with no deposit paired** → **`incomeNotArrived[]`**, off the curve. Income due today
     stays off the curve, as before.
4. **Otherwise** → on its own (moved-to) date.

- **Never overdue from before the item existed:**
  - a recurring item starts on its anchor date, else its created day;
  - a debt minimum starts on the debt's created day;
  - the Avalanche extra starts on the day its settings were last saved.
- **The lists** are bounded by the first of last month and by the item's start.
- **Candidate rows** are read back to the first of last month − 10 days (for the listing pass); the PR5a pass keeps its
  own windows (plans today−45 .. today+10, rows today−59 .. today).
- **The #666 drop and the #688 exception are gone**, except for weekly-cadence expenses.

### ⚠️ Weekly-cadence expenses keep the old rule until PR8

- **`keepsPreSnapshotRule(item, amount)`**: an expense whose item is `weekly` or `biweekly` keeps the pre-PR6 #666/#688
  rule and the drag exactly as on the base, and PR5a's `offCurve` rule. Due before today it is tagged
  `dragged_past_due`; due today it is `due_today_not_posted`, like any other plan. It is never listed.
- **Why:** the Weekly Spend reserve is a plain weekly bill no bank row ever pays; the overdue rule would drag up to two
  weeks of it ($450 × 2 in the seed) onto one day.
- One named predicate, so PR8 can delete it. Income of every cadence gets the new rule.

### API (`CashSignal`, OpenAPI + codegen)

- **`events[]`** gains:
  - `assumption` (nullable): `overdue_assumed_unpaid`, `overdue_remainder_assumed_unpaid`, `due_today_not_posted`,
    `dragged_past_due` or `pre_window_on_first_day`;
  - `occurrenceKey` (`<itemId>|<occurrenceDate>`);
  - `occurrenceDate`, the resolution key date, never the moved-to date.
- **`overdueOutsideForecast[]`, `incomeNotArrived[]`**: `planKey`, `itemId`, `occurrenceDate`, `dueDate`, `amount`,
  `label`, `daysOverdue`.
- **`overdueAssumedPaid[]`** (review): `planKey`, `itemId`, `occurrenceDate`, `dueDate`, `label`, `daysOverdue`,
  `planAmount`, `txnId`, `txnAmount`, `confidence` ("high" / "medium" / "low", or "card_payment"),
  `unpaidRemainder`.
- All sorted by due date, then label. PR12 can offer Confirm / Not this from `overdueAssumedPaid`, and the web can join
  any entry to `matches` by `planKey`.

### The moved-bill key

- **Ledger:** every plan carries `occurrenceDate`; `originalDate` keeps its meaning (the date it was due after any move).
- **Web:** `lib/forecastPastDue.ts` builds the card's and tooltip's lines; Mark missed, "Mark matched to…" and Skip send
  `occurrenceDate`.
- **Answers the old card already wrote:** a matched / skipped / missed / dismissed on a moved bill's moved-to date still
  closes that bill (the register read it that way too), unless that date is an occurrence of the item in its own right.
  The remap never moves such an answer (H2).

### One-time bills (`archiveExpiredOneTime`)

- **Chosen bound: 60 days.** An unresolved one-time bill stays active while its due date (after any move) is within the
  last 60 days, or ahead.
  - "Resolved" = matched, skipped, missed or dismissed, on its occurrence or its moved-to date.
  - `partial` is not resolved.
- **Nothing else moves:** every reader that counted only active bills treats a one-time bill dated before today as
  archived, as before (`isPastOneTime`):
  - the Budget page plan;
  - the auto-bills category heal and income category sync;
  - the Bills totals;
  - a debt's linked bill;
  - the Reports → Cash flow run-rate;
  - (review) the dashboard's upcoming bills.

### Schedule edits (read-only, `lib/resolutionRemap.ts`)

- **At read time, a resolution whose date is not an occurrence of its item maps to the item's occurrence in the same
  period.** The period is the same calendar month (monthly, quarterly, annual, debt minimums), or the nearest occurrence
  within 3 days (weekly) or 7 days (biweekly, semimonthly).
- **Conditions:**
  - it maps only when that occurrence has no resolution of its own, no earlier orphan claimed it, and (review) the date
    is not one the item was moved to;
  - ties and one-time or inactive items never map.
- **Nothing is written.** The ledger and the `/forecast` bundle share it, so the register and the curve agree.

### Recurrence

- Monthly day 31 → Feb 28, Mar 31, Apr 30 is now a test; expansion was already right and is unchanged.

## Figures that should move

**Against `9923add` (the pre-snapshot drop), golden full household** (snapshot 05-08, today 05-14). Rent due 05-01
(−1,500.00) and the Avalanche extra due 04-30 (−150.00) are unpaid in the fixture, so they now land on 05-15.

| Entry | Figure | `9923add` | This PR |
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

**Golden against the previous head `03815aa`: no curve figure changes in any entry.** Only the lists change:
- the Golden Card minimum due 04-25 moves from `overdueOutsideForecast` to `overdueAssumedPaid`: a medium pair with a
  $20 row, `unpaidRemainder` −18.00; in the PR4b entry, a $35 row, −3.00;
- every other entry gains an empty `overdueAssumedPaid`.

**The reviewer's household cases** (today = snapshot = Tue 05-05, buffer 500, 90 days; figures are max safe extra
unless noted):

| Case | Pair | `9923add` | `03815aa` | This PR |
|---|---|---|---|---|
| R1 rent $1,500 by Zelle, no name | low | 2,500 | 1,000 | **2,500** |
| R2 rent by check | low | 2,500 | 1,000 | **2,500** |
| R3 mortgage $2,085.79 "LOAN PMT" + HELOC $1,130 paid $1,185.19 "FIGURE LENDING" | low / medium | 5,500 | 2,284.21 | **5,500** |
| R4 card minimums $40 + $38 paid $812.40 / $400 | none → card payment | 2,500 | 2,422 | **2,500** |
| R5 Avalanche extra $500, "ONLINE PAYMENT THANK YOU" | low | 2,500 | 2,000 | **2,500** |
| R6 rent actually unpaid | none | 2,500 | 1,000 | **1,000** |
| R7 whole household, all paid: low point | mixed | 6,500 | 3,368.43 | **6,500** |
| R7 max safe extra | | 6,000 | 2,868.43 | **6,000** |
| City Water $150 paid $120 (named, low) | low | 2,500 | 2,470 | **2,470** (−30 remainder) |
| Avalanche extra set today, 04-30 unpaid | — | 2,500 | 2,000 | **2,500** |

These tests use their own fixtures that reproduce the reviewer's figures. A monthly paycheck covers each month's bills,
so the max safe extra reflects the overdue plans only.

**Old moved-to-date answers** (Storage $300 due the 28th, April moved to 05-02, balance 2,400, buffer 0):
- **Matched or missed on 05-02:**
  - on 05-14: 2,400 until 05-27, then 2,100 on 05-28 (`03815aa`: 05-15 onward 2,100 and no May bill);
  - on 05-17: low 2,100 on 05-28 (`03815aa`: 2,400).
- **A Move on 05-02 (to 05-10), which the ledger does not follow:**
  - on 05-14: April drags onto 05-15 (2,100) and May 28 is due (1,800);
  - on 05-17: April is listed (15 days), and May 28 is due (low 2,100 on 05-28).

**What Brad will see move, live:**
- **DOWN:** every unpaid bill due in the last 14 days that #666 hid.
- **Unchanged from `9923add`:** a bill a payment covered, named or not, which now shows up in `overdueAssumedPaid`.
- **UP** (from `03815aa`'s behaviour): paid rent, mortgage, HELOC, card minimums and the Avalanche extra no longer dip.
- **UP:** a bill whose due day was edited after a match no longer has an unpaid twin.
- **UP:** Mark missed / Skip / match on a moved bill now takes it off the curve.
- **Unchanged:** day 0 and cash today (`bankToday` identical in all golden entries and R1–R7); weekly and biweekly
  expenses; plans due after today; `matches`.
- **Not measured:** the live household's figures. That needs a read-only GET in Brad's browser, which this build did not
  do.

## Must not change

- `bankToday`, the spine bank balance and spine parity (the parity test passes).
- The review count (nothing is written) and spending.
- The Budget page `plannedTotal` / `planBySource` (a test: a kept one-time bill changes neither).
- Server auto-match stays off; PR5a's `offCurve` and the matcher's pairing are unchanged for plans due after today.
- No DDL, no new dependencies (`pnpm-lock.yaml` unchanged); landing bundle 572.6 KB of 580 (572.5 before merging
  main's household-clock leftovers).
- Send-to-Forecast single flow.

## Residuals

- **⚠️ The accepted risk, at its real width** (top of this note; X2, X3, E6): a row sharing one word of the label
  within max($25, 25%) and 10 days before to 14 after, or an exact nameless amount within 3 days, hides an unpaid bill.
  One bill per row, always listed in `overdueAssumedPaid`. ⏳ Pending Brad's decision.
- **Not visible to the user yet:** `card_payment` and listing-pass pairs are not in `matches`, so the "Suggested" list
  can't offer "Not this" for them until PR12.
- **Errs low:**
  - E4: a partial's remainder paid by a later row still drags;
  - E2/E2b: a bill paid by two smaller rows drags in full.
- **A card payment must use PR7's rule and name the card as a word.**
  - "APPLECARD GSBANK PAYMENT" is a card payment with no word "apple", so an Apple Card minimum paid that way still
    drags (errs low).
  - A Capital One payment without PR7's phrase ("CAPITAL ONE MOBILE PMT") still drags, unless Plaid's category or the
    user's flag marks it.
- **X1:** a same-amount savings transfer can keep a missing paycheck out of `incomeNotArrived` (list only).
- **A named underpayment** counts as paid except for its remainder. If the row was actually a different bill from the
  same payee, the curve is high by the row until the user answers "Not this".
- **Two cards from one issuer.** Both minimums match a payment carrying the issuer's name ("CAPITAL ONE"); one payment
  pays only one of them, nearest date first.
- **Weekly-cadence expenses** keep the pre-snapshot drop and its weekend double lump until PR8 turns Weekly/Monthly
  Spend into Amex payoff events.
- **An old-card answer on a moved-to date shared by two moved occurrences** of the same weekly item closes both.
- **A second Move written on a moved-to date** is not followed: the bill stays at its first moved-to date. The register
  doesn't follow it either.
- **Silent before the first of last month:** nothing older is dragged or listed (28–61 days back).
- **The Avalanche extra's start moves** whenever its settings are saved (raising the extra, or the Budget page's
  planned amount for it), so an unpaid month end before that save is not overdue.
- **Listing-only pairs** (occurrences before today−45) appear in `overdueAssumedPaid` but not in `matches`, so the
  Review "Suggested" list doesn't show them.
- **Back-dated anchors.** An item created recently with an old anchor can list occurrences back to the first of last
  month.
- **Income due today** is off the curve and not listed; an ambiguous deposit leaves a paycheck listed as not arrived.
- **A snapshot dated after today** (clock skew) drags plans between today and the snapshot day as
  `due_today_not_posted`.
- **One-time bills:**
  - bills already archived before this deploys stay archived;
  - a kept one shows as active in the Bills list (no total counts it);
  - editing a one-time bill's date orphans its resolution (one-time bills never map).
- **The Bills "actual paid" (#70)** reads stored resolution dates.
- **The web shows no tags or lists yet** (PR12).
- **Playwright e2e not run:** `forecast-dragging-plans-summary`, `forecast-tooltip-mark-missed`,
  `forecast-chart-day0-bank-balance`.

## Tests

- **Second review:**
  - `planMatch.test.ts` (+6):
    - E6: a Target purchase, an Apple Store receipt and a Capital One car loan pay nothing;
    - the Discover refund pays nothing;
    - the issuers' payment phrases pay;
    - a flagged row and a Plaid-categorised row pay, but only with the card's name;
    - "APPLECARD GSBANK" (no word "apple") pays nothing.
  - `cashSignalOverdueEvidence` (+1): E6 end to end, where all four minimums drag (05-06 2,862.00, max safe extra
    2,362.00). R4 and R7 use PR7's "CAPITAL ONE MOBILE PYMT" and stay at base.
- **`cashSignalOverdueEvidence.integration.test.ts` (18, review):**
  - R1–R7 with the figures above;
  - a named remainder (−30.00 on 05-06);
  - HIGH 2 on 05-14 and 05-17 for matched and missed (4), a Move on both days (2), and the bundle keeping the answer on
    05-02;
  - the Avalanche start (set today vs January);
  - the January-snapshot bound (only 04-15 listed);
  - Comcast 56 days old paid by name (listed as paid, not in `matches`).
  - **No-name and partial-name paid cases:** R1, R2, R3's mortgage and R5 (no name); R3's HELOC (part of the name).
- **`cashSignalOverdue.integration.test.ts` (15):**
  - (review) "an overdue bill with only a low suggestion still drags" is **replaced**, because the adopted rule
    reverses it: a low non-ambiguous pair now counts as paid (1,000.00 on 05-15) and is listed. A new test keeps an
    ambiguous pair dragging in full (940.00).
  - The other 13, unchanged:
    - today−15 listed, today−14 dragging;
    - today's bill;
    - a skipped occurrence;
    - income not arrived;
    - pre-start occurrences;
    - bills moved beyond and into the window;
    - Mark missed with the occurrence key;
    - the old moved-to-date key, and its own-occurrence exception;
    - due day 14 → 20 after a match;
    - one-time bills after a page load;
    - the weekly exception (two tests).
- **`cashSignal.integration.test.ts` (11 changed):**
  - the three #666/#688 tests replaced by a stricter paid/unpaid pair plus stricter versions of their scenarios;
  - the #667 debt-minimum and Avalanche-extra flips;
  - #688, the snapshot-day test, #681 income and the #667/#681 boundary pin tags and figures;
  - fixture precision: debt `createdAt`, avalanche cleanup, and (review) the Avalanche extra's `updatedAt` pinned
    before 04-30.
- **`planMatch.test.ts` (+5, review):**
  - `plansPaidInFullByName` pays each minimum by its card's payment;
  - the matcher itself finds no pair for that payment;
  - no payment for less, another card's name, no name, or the wrong sign;
  - window edges (10 before, 14 after);
  - one row per minimum, and a rejected pair.
- **`resolutionRemap.test.ts` (12):** the earlier 11, plus (review) a moved-to date is never an orphan.
- **`cashSignal.test.ts` (+1):** day 31 → Feb 28, Mar 31, Apr 30.
- **`budgetPlanBySource.integration.test.ts` (+1):** a kept one-time bill leaves `planBySource` unchanged.
- **Golden (11):** re-recorded; see Figures. The golden's Avalanche settings pin `updatedAt` (January).
- **Web `lib/forecastPastDue.test.ts` (5):** the card and tooltip send the occurrence key.

## Failing before

**Second review** — against `66b48ee` with the new tests copied in: both E6 tests fail (the unit test and the end-to-end
test).
- The other new unit tests pass there, as they should: the refund, the issuer phrases paying, the flag or Plaid category
  paying with the name, and "APPLECARD GSBANK" not paying.
- R4 and R7 with PR7's issuer phrase also pass there; they pin that real card payments keep paying.

**Review fixes** — against the source before them (`26e1c62`, with the new tests and snapshot copied in): **36 of the 38
new or changed tests fail.**
- **`cashSignalOverdueEvidence`, 18 of 18.** The 05-17 Move test was strengthened to pin the low point's date: before
  that, it also passed on `26e1c62`, where the bug gave the same 2,100 low on 05-18.
- **`cashSignalOverdue`, 2 of 2:** the paid low pair and the ambiguous pair.
- **Golden, 11 of 11** (`overdueAssumedPaid`).
- **`planMatch`, 4 of 5.** Still passing: "the matcher itself finds no pair", which pins unchanged behaviour.
- **`resolutionRemap`, 1 of 1.**
- **`cashSignal.integration`, 0 of 1** (fixture pin only).

**First round** — against pre-PR6 source (`9923add`, with PR6's files swapped back): 49 of 54 failed.
- **`cashSignal.integration`, 9 of 11.** Still passing: the snapshot-day test (it always dragged) and the #687 synthetic
  debt minimum (fixture only).
- **`cashSignalOverdue`, 12 of 14.** Still passing, exactly:
  - "a Sunday snapshot with an unresolved weekly $300 expense: the same daily figures as before PR6";
  - "a Mark missed the pre-PR6 card sent on the moved-to date still closes the moved bill" (on the base, #666 hid that
    bill).

  "…tagged dragged_past_due, and never dragged or listed as overdue" fails on the base.
- **Golden 11 of 11; `budgetPlanBySource` 1 of 1; `resolutionRemap` 11 of 11; web `forecastPastDue` 5 of 5; day 31 0 of
  1.**

## Verification

**After the second review and the merge of `origin/main` (`11a6f75`):**
- **Workspace typecheck:** clean.
- **Full API suite (`CI=true`):** **136 files, 1268 pass, 7 todo**. The golden compares clean.
  - Before the merge, with the card-payment fix alone: 135 files, 1249 pass, 7 todo.
- **Web suite:** **128 files, 1025 pass** (the merge brought web week-helper changes).
- **Build and landing guard:** `pnpm run build` exit 0; `check-entry-graph` OK, **572.6 KB of 580**. It was 572.5 KB
  before the merge; the 0.1 KB came with main's household-clock leftovers, since PR6's changes this round are server-side.
- **Codegen:** a fresh run changes nothing (no spec change this round).

**After the first review fixes:**
- API suite: 135 files, 1243 pass, 7 todo.
- Web suite: 127 files, 1015 pass.
- The golden passed three separate runs.

## Left for later

- **PR8:** delete `keepsPreSnapshotRule` when Weekly/Monthly Spend become Amex payoff events.
- **PR12:**
  - show `assumption` badges and the three lists;
  - Confirm / Not this from `overdueAssumedPaid`;
  - the tooltip reads `assumption`;
  - update the three e2e specs.
- **Questions for Brad:**
  - Should editing a one-time bill's date carry its resolution?
  - Should income due today be listed?
