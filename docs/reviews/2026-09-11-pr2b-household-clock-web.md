# PR2b — One household clock, browser side

Codex work-order points **1** (every screen agrees on cash today, including the snapshot day) and **8**
(one household week boundary and timezone everywhere).

This follows PR2a (`11bee8f`), which moved the server onto the household calendar. Plan:
`~/.claude/plans/h2-budget-work-serene-pebble.md`.

## The problem

After PR2a the server answers "today", "this month" and "what day was the bank snapshot" in America/Chicago.
A few places in the browser still worked those out in UTC. That is already tomorrow between 7pm and
midnight Central, so the page and the server disagreed for five hours every evening:

- **The "Today" group on the Chase and Amex pages** moved to tomorrow at 7pm. It came from
  `new Date().toISOString().slice(0, 10)`.
- **Default dates on forms.** The Add Transaction dialog and the Avalanche "record a payment" dialog
  defaulted to tomorrow. An evening entry was saved a day late unless someone corrected it.
- **The Budget "on pace" strip** compared against the UTC day and month. It ran a day ahead in the
  evening and vanished on the last evening of a month.
- **The bank snapshot's day was read by slicing the stored timestamp.** A 9pm Central snapshot counted
  as tomorrow's, disagreeing with the server's roll-forward. Affected:
  - the Forecast register's running balance
  - the snapshot date shown on the Forecast bank card
  - month-close reconcile
  - the Chase and Amex ending balances
- **Post-link month links** fell back to the UTC month, as did the "still importing recent activity"
  hint.

## What changed

- **`lib/avalanche-core/package.json`** adds a subpath export, `@workspace/avalanche-core/householdTime`.
  The browser imports the calendar without the payoff simulator behind the package root.
- **`artifacts/h2budget/src/lib/householdDay.ts`** is the browser's household calendar.
  - It provides `householdToday()`, `householdMonthStartOf()` and `householdDayOfAt(at)`.
  - `householdDayOfAt` returns a bare `YYYY-MM-DD` unchanged. Parsed as an instant, that would be UTC
    midnight, which is 7pm the previous evening in Chicago.
  - Any other value is read as an instant. A malformed one falls back to its first ten characters, as
    the old slice did, instead of throwing during render.
- **Call sites** now take their date from that calendar:
  - `transactions.tsx`: the "Today" group, and both Add Transaction default dates.
  - `amex.tsx`: the "Today" group, and the ending balance's "as of" label.
  - `avalanche.tsx`: both payment-dialog default dates.
  - `budget.tsx`: the pace strip.
  - `plaid-link-button.tsx`: month fallback, and the "still importing" check.
  - `post-link-progress.tsx`: month fallback.
  - `forecast.tsx`: the register's snapshot day and the displayed snapshot date.
  - `forecastReconcile.ts`: the snapshot day.
  - `chaseEndingBalance.ts`: the snapshot month and day.
  - `accountBalance.ts`: the anchor day.
  - `amexEndingBalance.ts`: the anchor month.
- **The Amex anchor route, `routes/amex.ts`,** so that a calendar day never travels as UTC midnight:
  - `GET /amex/anchor` sends the computed balance's date as a bare day (first review, finding 1).
  - `POST /amex/anchor` stores a bare-day `asOf` at noon UTC, the same household day all year (second
    review, finding 1). It rejects a bare day that does not exist (third review, finding 1).
- **`lib/api-spec/openapi.yaml`** describes when `AmexAnchor.asOf` is a bare day. Codegen changed only
  doc comments and zod `.describe()`.

## Figures that should move

Mostly only between **7pm and midnight Central** (6pm to midnight in winter), and only on pages that do
their own date work. From midnight to 7pm Central the UTC and Central dates are the same, and the page
did not change.

| Where | Evening behaviour now |
|---|---|
| Chase and Amex "Today" group | Still today |
| Add Transaction and record-payment dialogs | Default to today, so the saved date is today |
| Budget "on pace" strip | Correct day of the month, and still shown on the month's last evening |
| Forecast register running balance; Chase and Amex ending balances; month-close reconcile | Anchored to the snapshot's own day, matching the server's bank balance |
| Forecast bank card | Shows the day the snapshot was taken |
| Post-link month link, "still importing" hint | The household's month |

**One label moves at every hour.** When the Amex tile says "Calculated", its "as of" date now shows the
latest transaction's own day. It used to show the day before, because the date was read as UTC midnight.

No stored data is rewritten. Only newly entered dates follow the corrected default.

## Must not change

- **Every daytime figure, and every Amex ending balance.** The first draft of this PR raised the
  "Calculated" Amex balance. Review caught it before commit, and the fix restores the live figure.
- **The landing page:** `layout.tsx` and `useLandingWarmup.ts` were deliberately not touched. They
  already use the browser's local month, which is Central for the household, and they sit on the landing
  path.
- **Server code**, apart from the Amex anchor route above.
- **The API's shape.** The spec gains a description only.

## Tests

- **New `householdDay.test.ts`:** 6 tests.
  - A bare date passes through unchanged.
  - A 9:30pm Central snapshot keeps its own day.
  - A daytime instant matches UTC.
  - A malformed or empty timestamp falls back instead of throwing.
  - Saturday 8:30pm Central is still Saturday.
  - The last evening of a month is still that month.
- **`forecastReconcile.test.ts`** fixtures moved from `2026-05-15T00:00:00.000Z` to
  `2026-05-15T17:00:00.000Z` (noon Central).
  - The fixtures model a snapshot on May 15. 00:00Z is 7pm on May 14 in Chicago, so under the
    household calendar they would have described the wrong day.
  - Every expectation is unchanged. This keeps the tests' intent; it does not weaken them.
- **Added after review.** Each case says what the old UTC code gave, where it differs.
  - **`amexAnchorRoute.integration.test.ts`:**
    - With only $30 on Sep 2 and $50 on Sep 10, the computed source returns **$80, as of `2026-09-10`**.
      The old route sent `2026-09-10T00:00:00.000Z`.
    - A POST with `asOf: "2026-04-01"` stores **`2026-04-01T12:00:00.000Z`**. The expectation moved from
      UTC midnight on purpose (see the second review).
    - A bare day that does not exist returns 400: `2026-13-45`, `2026-02-29`, `2026-02-30` and
      `2026-04-31`. V8 would roll the last three into the next month, and the old code saved them.
    - A real leap day, `2028-02-29`, is still accepted and stores **`2028-02-29T12:00:00.000Z`**.
  - **`amexEndingBalance.test.ts`:**
    - The same balance dated `2026-09-10T00:00:00.000Z` gives **$130**: the Sep 10 rows count after 7pm
      on Sep 9. This pins why a day must not travel in that shape.
    - A computed anchor with a bare day ends its month at the sum, **$80**. The old code also gives $80,
      so the route test above is what guards this case.
  - **`accountBalance.test.ts`:**
    - A 9:30pm Central snapshot on Apr 15 counts Apr 16's −$60, giving **$940**. The UTC slice gave
      $1,000.
    - The month-end fixture now really is 11:59:59pm Central and includes an Apr 30 row. It used 6:59pm
      Central before. The old code passes it too: this corrects the fixture, it does not tighten the
      test.
  - **`forecastReconcile.test.ts`:**
    - A 9:30pm Central snapshot on May 15 still counts a May 16 plan of −$40, giving **$960**. The UTC
      slice gave $1,000.
    - A snapshot at 9:30pm Central on Apr 30 does not make April a prior month. The UTC slice said it did.
      Until a newer snapshot replaced it, the Forecast page marked April "Prior period" and did the
      following:
      - hid the Forecast · Bank and Projected end figures
      - never showed the month as reconciled
      - closed the month with every reconcile figure blank
  - **`chaseEndingBalance.test.ts`:** a snapshot at 9:30pm Central on Apr 30 ends April at **$1,000** and
    May at **$940** after May 1's −$60. By day, Apr 30 is **$1,000** and May 1 is **$940**. The UTC slice
    gave $1,060 and $1,000 for both.
  - **`budgetAnalysisStrip.test.tsx`:** the pace pill still shows at 10pm Central on May 31.
  - **`plaidPostLinkProgressPanel.test.tsx`:** at 10pm Central on May 31, an import reaching May 30
    shows no "still importing" hint.
  - **Not covered by a page test:** the default dates and the Forecast page's own two sites go through
    `householdToday` and `householdDayOfAt`, which are tested directly.

## Verification

- **Workspace typecheck:** passes, including libraries, API and web.
- **Codegen:** only the `asOf` description changed. The generated files are committed.
- **Web tests:**
  - Full suite with the clock in UTC, as on CI: **109 files, 802 pass**.
  - The new and changed tests on Chicago time: 7 files, 74 pass.
- **API tests:**
  - Amex anchor route: 13 pass.
  - Full suite: **112 files, 795 pass plus 8 pending**, on an isolated database with the Mac held awake.
    That is three tests more than PR2a: the computed anchor route, the dates that do not exist, and the
    real leap day.
- **CI:** green on `1f2d862` and on `e41d321`. The last commit, tests and this note only, merges on green.
- **Build:** passes. The calendar is its own lazy chunk (`householdTime-*.js`, 0.80 kB).
- **Landing bundle guard:** **571.3 KB of 580**, up 0.1 KB. No recharts on open, and the calendar chunk
  is not preloaded.

## First independent review, and what was done

A separate reviewer read the diff before commit. It confirmed these areas were clean:
- **Landing bundle:** the extra 0.1 KB is two chunk file names.
- **Both write paths:** Add Transaction and record a payment.
- **Pairs of figures:** no other pair can now disagree.
- **Landing files:** untouched.

1. **HIGH — fixed. The computed Amex balance was counted a day twice.**
   - **The bug.** `/amex/anchor` falls back to "computed" when a card has no Plaid balance, debt row or
     saved balance. It sent the latest transaction's day disguised as UTC midnight,
     `2026-09-10T00:00:00.000Z`.
     - The old slice read that as Sep 10. `householdDayOfAt` read it as 7pm on Sep 9.
     - Sep 10's rows were therefore added again on top of a balance that already held them, at every
       hour, not only in the evening.
     - Example: $30 on Sep 2 and $50 on Sep 10 gave $130 instead of $80. When the latest day was the
       1st, the anchor month also slipped back a month.
   - **The fix is at the source.** The route now sends the bare day (the latest transaction date, or the
     household's today when there is none). The browser's calendar reads a bare day unchanged, so the
     balance matches the live figure again.
   - **The label had the same trap.** The Amex tile's "as of" label read the date with `new Date(day)`,
     which is UTC midnight and shows as the day before in Central. It now labels the household day.
2. **LOW — fixed.** `householdDayOfAt` threw a RangeError on an empty or malformed string.
   - Untyped stored values could hit it, such as a Chase snapshot `at` or a legacy Amex anchor, replacing
     the page with the error panel.
   - It now falls back to the text's first ten characters.
3. **LOW — fixed.** Evening-edge tests were thin. The tests listed under "Added after review" cover them.
4. **Wording — fixed.** UTC and Central dates agree from midnight to 7pm Central, not from 9am, and the
   winter window is 6pm to midnight. PR2a's note had the same wording and is corrected too.
5. **Nits — done.**
   - The Chase and Amex "today" helper calls `householdToday(d)` directly.
   - The post-link `firstOfCurrentMonthIso` wrapper is gone.

## Second independent review, and what was done

A second reviewer read the fixes before commit and **approved**. It confirmed these areas were clean:
- **Every reader of the Amex `asOf`.**
  - The Amex page is the only one, and the per-card query uses the same server branch.
  - The debt branch's date comparison never sees the computed value.
  - Nothing on the spine, dashboard, landing or e2e specs reads it.
- **No other server response sends a day as an instant.**
  - Snapshot, balance and sync times are all written from `new Date()`.
  - `budgetFacts` and `reports` return bare days.
- **The Amex label:** correct for bare days, instants and malformed values, in any browser timezone.
- **The new tests fail on the old code in both timezones:** the route test, the evening anchor, the
  UTC-midnight Amex case, the pace strip and the post-link hint.

1. **LOW — fixed. `POST /amex/anchor` still stored a bare day as UTC midnight.**
   - The app never sends one: the Amex page posts a full timestamp.
   - A direct call with `asOf: "2026-04-01"` would have saved 7pm on Mar 31 Chicago time, and Apr 1's rows
     would have counted twice.
   - It now stores noon UTC, which is that day in Chicago all year. The existing test's expectation moved
     from `2026-04-01T00:00:00.000Z` to `2026-04-01T12:00:00.000Z`.
2. **LOW — fixed.** Reconcile and the Chase ending balance had no evening test, so reverting either to
   the UTC slice still passed. Both have one now.
3. **NIT — fixed in this note.** The month-end fixture and the bare-day Amex test pass on the old code
   too. The note no longer calls the first stricter, and says the route test guards the second.
4. **NIT — done.** The spec now describes when `asOf` is a bare day.

## Third independent review, and what was done

A third reviewer read only the hunks written after the second review, and **approved**. It confirmed
these were clean:
- **POST parsing:** full ISO instants and other parseable strings take the same path as before, and
  unparseable text still returns 400.
- **Every reader of a noon-UTC anchor:**
  - The GET anchor branch passes it through.
  - The Amex page reads it as the same household day.
  - `refreshAmexAnchor` and the restore script only ever write the current time.
- **Codegen:** only the description changed, in both the generated source and the committed `dist` files.
- **This note:** its test counts and dollar figures.
- **The evening tests fail on the old code**, whatever the machine's timezone:

  | Test | Old code | New code |
  |---|---|---|
  | Reconcile, May 16 plan | $1,000 | $960 |
  | Reconcile, is an Apr 30 evening snapshot a prior month? | yes | no |
  | Chase month end, Apr / May | $1,060 / $1,000 | $1,000 / $940 |
  | Chase day end, Apr 30 / May 1 | $1,060 / $1,000 | $1,000 / $940 |

1. **LOW — fixed. A bare day that does not exist was saved.**
   - V8 rolls `2026-02-30` over to Mar 2 rather than failing, so a direct POST dated Feb 30 saved an
     anchor on Mar 2.
   - The old code did the same. But this note and the test name claimed every impossible day returned
     400.
   - The route now rejects a bare day that does not survive the round trip, and the test covers Feb 29
     in a non-leap year, Feb 30 and Apr 31.
2. **NIT — fixed.** A reconcile test comment said the old code shorted April's `forecastEnd`, which it did
   not. The comment now says what the wrong flag did.
3. **NIT — accepted.** The debt branch keeps the later of the debt row's update time and the saved
   anchor's `asOf`.
   - A bare-day POST stored at noon UTC now outranks a debt row updated earlier that UTC day, which is 7pm
     the evening before to 7am Central.
   - `asOf` then moves to that day while the balance stays the debt's, so that day's rows are treated as
     already inside it.
   - Only a direct API call can do this. It is listed below.

**The follow-up commit, `e41d321`, went back to the same reviewer, which approved it.**
- It checked the round trip in Node: 2028-02-29 and 2000-02-29 pass; 2026-02-29, 2026-02-30, 2026-04-31
  and 1900-02-29 are rejected.
- It confirmed every Forecast-page effect claimed above against `forecast.tsx`.
- It left three optional nits, all applied in the last commit, tests and this note only:
  - a real leap day now has its own test;
  - the prior-month bullet says the wrong flag lasted until a newer snapshot and blanked every reconcile
    figure;
  - the deferred bullet gives the full 7pm-to-7am window.

## Deliberately not in PR2b

- **Pages whose memoised "today" never rolls past midnight:** Allowances, Forecast, Chase, Reports.
- **Browser-local date arithmetic,** which already means Central for the household on its own devices.
- **`debts.ts` reads a bare `lastBalanceUpdate` as UTC midnight,** the same trap as the Amex POST. The web
  never sends a bare day there.
- **A bare-day Amex anchor POST can outrank a debt row updated earlier that UTC day,** from 7pm the
  evening before to 7am Central (third review, NIT 3). Only a direct API call reaches it.
- **The `AmexAnchor.source` spec enum lacks `plaid`,** which the route already returns. That predates
  this PR.
- **The debt "paid off this month" edge, `debtPending`'s end-of-day cutoff, and the other server
  deferrals** listed in PR2a's note.
