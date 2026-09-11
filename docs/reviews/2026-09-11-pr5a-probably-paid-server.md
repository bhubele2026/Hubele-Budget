# PR5a — "Probably paid": a plan a bank row confidently paid leaves the curve (server)

Codex work-order point **6** ("probably paid" matching), plan PR5, server half. The web half — "Suggested" in Review,
Confirm / Not this / Partial — is PR5b. Built on `main` with PR4c, PR4e and PR7 merged (`56596f3`). Plan:
`~/.claude/plans/h2-budget-work-serene-pebble.md`.

| Commit | What it does |
|---|---|
| `c235f37` | `lib/avalanche-core/src/planMatch.ts` — the pure matcher, with unit tests. |
| `2f3d305` | Resolutions: "Not this" (`not_match`) and `partial`; narrowed neighbour delete; review count. |
| `a7d1428` | The ledger uses the matcher; `CashSignal.matches`; OpenAPI + codegen; golden re-recorded. |
| `faefe3d` | Merge of `origin/main` (PR7). Only generated declaration maps conflicted; regenerated. |
| _review fixes_ | Only confident pairs leave the curve (`offCurve`); word-set evidence; earlier occurrences compete; partial keeps a reschedule; `not_match` takes back a match; bundle filter; tests. See **Review fixes** below. |

## The problem

**A bill that is already paid can still weigh on the forecast.**
- A planned payment stays on the curve until someone matches it to the bank row that paid it.
- The row counts in cash as soon as it posts, so until then the bill counts twice: once as the real row, once as the
  plan.
- **Example:** a $150 water bill paid at $173. The row takes $173 out of cash; the unmatched plan takes another $150
  on its due date, so the curve dips by $323 instead of $173.
- Server auto-match is off by design (`plaidSync` `AUTO_MATCH_ENABLED=false`). The only matching on `main` is a
  suggestion list the web computes on its own.

## What changed

### The matcher (`matchPlansToRows`, `lib/avalanche-core/src/planMatch.ts`)

**A plan and a bank row pair (a suggestion)** when all of these hold:
- same sign;
- the row is dated 10 days before to 14 days after the plan;
- **with the payee's name** (a distinctive word of the plan's label appears as a whole **word** of the row's
  description): the amounts differ by at most max($25, 25% of the plan);
- **without it:** they differ by at most max($1, 1%), and the dates are at most 3 days apart.

**How the pairing works.**
- **Words, not substrings.** Label and description are split into word sets once each (`tokenizeDescription`), so
  "rent" never matches "PARENTS" and "water" never matches "WATERFORD".
- **Stop-words never count as evidence:**
  - payment words: "minimum" (every debt label), "payment", "pmt", "ach", "autopay", "online";
  - generic nouns that name no one: city, county, state, insurance, loan, service, company, home, account, …;
  - "american" and "express" on their own.
- **Aliases:** "Amex" and the word sequence "American Express" count as the same payee. "American Water" is not Amex.
- **One to one:** best score first, where score = |Δcents| + 100·|days| − 5,000 with the name.
- **`ambiguous`:** a runner-up for the same plan or row scores within max(100, 10%).
- **`confidence`:**
  - "high" = the name, within max($1, 1%), and within 5 days;
  - "medium" = the name, within max($25, 10%);
  - otherwise "low", including every pair without the name.
- **A rejected pair** (`not_match`) never pairs again.

**Only `offCurve` pairs leave the curve.** Everything else is a suggestion, and its plan still counts. A pair is
`offCurve` only when all of these hold:
- not ambiguous; and
- either a "high" pair (the payee's name, within max($1, 1%), within 5 days),
- or the plan's **full name** (every distinctive word of the label is a word of the description, an alias counting as
  one word) with the row paying no less than the plan minus max($1, 1%) and no more than the plan plus max($25, 10%).

The rule is asymmetric and name-strict on purpose:
- **An overpaid bill** ($150 "City Water" plan, $173 "CITY WATER UTIL" row) leaves the curve: the row already takes
  the full $173, so the bill counts once.
- **A different bill from the same payee** stays a suggestion: "VERIZON FIOS" −130 shares only "verizon" with the
  "Verizon Wireless" plan, and "AMAZON MKTPL US" −29.99 only "amazon" with "Amazon Prime".
- **An underpaid bill** ($38 plan, $20 row) stays on the curve until the user confirms "partial". Taking it off would
  hide the $18 still due and overstate projected cash. Keeping it understates cash by $20 at most, until the user
  answers.

### The ledger (`buildForecastLedger`)

After the resolutions are read, and before the plans loop:
- **Candidate plans:**
  - unresolved occurrences dated today−45 to today+10, after any reschedule, from the same expansion the curve uses;
  - excluded: plans matched, skipped, missed, dismissed, or with a `partial` resolution.
- **Candidate rows:**
  - checking rows dated today−59 to today, from their own read;
  - classified by the PR4e cash-row rule with no anchor, so rows the snapshot holds are still candidates, and a pending
    half its posted row replaced is not;
  - excluded: rows claimed by any resolution other than "Not this". A posted row whose replaced pending row is claimed
    counts as claimed.
- **Earlier occurrences compete.**
  - Last month's occurrence is a candidate too, so a late payment pairs with the bill it paid.
  - A later occurrence is never `offCurve` when an earlier occurrence of the same item, dated on or before the row, has
    no named pair (a nameless "low" pair never counts as paying it). The row may be that earlier bill, paid late.
- **In the plans loop:**
  - an `offCurve` plan is skipped before the pre-snapshot rule (#666). `bankToday` is final before this point and
    never moves.
  - A `partial` resolution keeps only the unpaid remainder (plan − paid row) on the curve, when more than $1 remains,
    on the rescheduled date if the plan was moved.
  - Its row counts as accepted, like a match (`acceptedImpact`).
- **Output:** `ledger.matches` becomes `CashSignal.matches`.
  - Fields: planKey, planItemId, planDate (the resolution key date), txnId, the plan and row amounts, difference
    (|row| − |plan|), dayDelta, confidence, ambiguous, **offCurve**.
  - It is in OpenAPI. Confidence is a plain string, so no runtime constant reaches the landing bundle.

### Resolutions (`POST /forecast/resolutions`)

- `not_match` and `partial` require a plan occurrence and a bank row.
- **Neighbour delete.** It used to keep one resolution per plan occurrence and one per row by deleting "neighbours".
  Now:
  - it leaves `not_match` rows alone, so a rejected suggestion never comes back after another decision about either
    side;
  - a `not_match` write replaces the identical pair's earlier answers: a rejection, a `matched` or a `partial`;
  - confirming a pair clears its rejection;
  - `partial` and `rescheduled` for the same plan coexist: the remainder is due on the moved date;
  - every other status behaves as before.
- **Review count:** a row whose only resolution is "Not this" still needs review.
- **`GET /forecast` bundle:** `not_match` and `partial` rows are left out of `resolutions` until the web register
  understands them (PR5b removes the filter). Today's register reads resolutions last-write-wins with no ORDER BY, so
  a "Not this" row could otherwise be read as the plan's or the row's decision.

## Review fixes (independent review of `3d207e8`: REQUEST CHANGES)

| # | Finding | Fix | Test |
|---|---|---|---|
| H1 | Any pair took its plan off the curve, including low-confidence and ambiguous ones. With no name, ±$1 within 3 days matched an unrelated purchase: $1,500 rent vs a $1,500 Zelle (overstated $1,500), Netflix vs Chipotle. | Only `offCurve` pairs leave the curve: the name, not ambiguous, and underpaid by at most max($1, 1%) or overpaid by at most max($25, 10%). Pairs without the name are always "low". | Zelle vs rent, Chipotle vs Netflix, $1,200 vs $1,500, ambiguous, no-name, income |
| H2 | Evidence was a substring: "rent" matched "PARENTS". Generic words counted. | Word-set match; the alias matches as a word sequence; generic nouns added to the stop list. | PARENTS, WATERFORD, HOMEGOODS, CITY OF, INSURANCE BROKERS, LOAN DEPOT, American Water |
| M3 | A logged Avalanche payment and its bank debit took two different card minimums off the curve. | Both pairs are ambiguous, so neither leaves the curve. | the logged payment plus ACH case |
| M4 | April's bill paid late took May's plan off the curve. | Plans from today−45 and rows from today−59; a later occurrence is not `offCurve` while an earlier unpaid occurrence is due on or before the row. | the late-payment case |
| M5 | Writing `partial` deleted the plan's reschedule, so the remainder vanished (overstated $250). | `partial` and `rescheduled` for a plan coexist in both write orders. | route: both orders; ledger: remainder on the moved date |
| M6 | `not_match`/`partial` rows reached today's web through the bundle. | Filtered from the bundle until PR5b; a `not_match` write also deletes `matched`/`partial` for the identical pair. | route: reject after match |
| L7 | The matcher tokenized every pair. | Sign, date and amount checks first; each label and description tokenized at most once. | — |
| L8 | A second `partial` for a plan replaces the first. | Disclosed (Residuals). | — |
| L9 | Missing tests. | Added (see Tests). | — |
| NIT | This note miscounted the golden fixture and misstated "medium". | Corrected below. | — |
| 2-M1 | _Second look (`f40c4b0`):_ a named row overpaying by up to max($25, 10%) took the plan off even when it was a different bill from the same payee: Verizon Wireless $120 vs VERIZON FIOS −130 (overstated $120); Amazon Prime $14.99 vs AMAZON MKTPL −29.99. | Beyond a "high" pair, `offCurve` needs the plan's full name. The reviewer's alternative (high pairs only) would put the $150/$173 acceptance case back at −$323 until answered. | Verizon/Amazon unit test; Verizon integration: 05-20 750.00 |
| 2-L2 | A nameless "low" pair counted last month's bill as paid, so its late payment took this month's bill off: HOME DEPOT −150 "paid" April, CITY WATER −150 21 days late took May off (overstated $150). | Only pairs with the name (`confidence` not "low") count as paying an earlier occurrence. | HOME DEPOT integration: 05-20 700.00 |
| 2-L3 | Many correct pairs stay on the curve (errs low). | Disclosed under Figures. | — |
| 2-NIT | Plan window, income below plan. | Disclosed under Residuals. | — |

## Figures that should move

- **The forecast curve, low point and projected balances:** up by every plan a recent bank row confidently paid. The
  bill now counts once, as the real row.
  - $150 plan paid $173 → the curve carries −$173 once, never −$323.
  - A bill paid 8 days early no longer dips again on its due date.
- **Unchanged:**
  - cash today (`bankToday`) and the spine's bank balance;
  - the review count (a suggestion is not a decision);
  - spending;
  - the Budget page;
  - plans with no likely row, and plans whose only pair is a suggestion (not `offCurve`);
  - plans outside today−45 to today+10.
- **Still counted twice until the user answers (errs low, by design):**
  - weekly items paid a few days early (ambiguous with the neighbouring week, so both weeks stay);
  - every later occurrence while an earlier occurrence of the item has no named pair (up to 45 days);
  - new weekly or biweekly items whose expansion invents occurrences before the anchor (PR6 scopes overdue plans to the
    anchor);
  - variable bills whose previous payment fell outside the band;
  - a named overpayment that carries only part of the plan's name ("Oak Street Rent" paid to "OAK STREET PROPERTIES" at
    +$20).
- **Golden:** every cash-signal snapshot gains `"matches"`, and no curve figure changes.
  - 6 lists hold one suggestion each, all for the same $38 debt minimum dated 04-25 ("golden" appears in both the debt
    name and the row descriptions):
    - the five full-household windows pair it with a $20 row 14 days later;
    - the PR4b snapshot-rule fixture pairs it with a $35 row.
  - The other 6 lists are empty (12 lists across the 11 snapshot entries).
  - Both pairs are "medium" and **not** `offCurve`: each row paid less than the plan.
  - The plan is dated before the snapshot, so it was already off the curve either way.
- **Not measured:** how many plans the household's live data would pair. That needs a read-only production query
  Brad approves.

## Residuals

- **An unanswered underpayment understates cash.** A named row that paid less than the plan leaves both on the curve
  until the user confirms "partial" (at most the row's amount too low).
- **An overpaid pair can still be wrong.** A row carrying the plan's full name, unambiguous and within max($25, 10%)
  above the plan, takes the plan off before the user answers. If the payee bills twice under the same name (two plans
  labelled only "Verizon"), the curve is too high by the plan until "Not this".
- **Income below plan.** A deposit more than max($1, 1%) below its plan keeps the plan on the curve, so both count, as on
  `main`.
- **The plan window** is the later of today−45 and the first of last month (the curve's expansion start).
- **The web doesn't show matches yet (PR5b).** Until then:
  - the Forecast register still lists an `offCurve` plan as "Pending plan", while the curve has already dropped it;
  - the web's own suggestion list runs its own rules;
  - `forecastReconcile` still adds the plan into its "Forecast" end figure.
- **One `partial` per plan.** A second partial for the same plan replaces the first; the remainder is plan − the
  latest row.
- **Label evidence is a word match.** A distinctive but shared word ("golden" in the fixture) still pairs unrelated
  names. Such pairs leave the curve only when the amount also agrees and nothing competes.
- **Horizon.** Candidate plans come from the curve's own expansion, so a request with fewer than 10 days ahead sees
  fewer candidates. Every web caller asks for 30 days or more.
- **Only the checking account.**
  - A payment from the Amex, or another account, is matched only by an explicit resolution, as before.
  - The logged Avalanche payment and its bank debit (a separate open question for Brad) are two checking rows. When
    both could pay a minimum, the pairs are ambiguous and nothing leaves the curve.

## Must not change

- `bankToday`, the spine bank balance, spine parity and the review count.
- Server auto-match stays off; nothing is written.
- The pre-snapshot rule, the past-due drag, reschedule/skip/missed behaviour.
- The golden curve figures (only `matches` is added).
- No new dependencies; no DDL.
- Landing bundle within the cap.

## Tests

- **`lib/planMatch.test.ts` (19):**
  - evidence: stop-words; whole words only (PARENTS, WATERFORD, HOMEGOODS); generic nouns; the Amex alias and
    "American Water";
  - $150/$150 high and `offCurve`;
  - $150/$173 medium, difference +23, `offCurve`;
  - $38 plan with a named $20 row: a suggestion, not `offCurve`;
  - Verizon Wireless vs VERIZON FIOS and Amazon Prime vs AMAZON MKTPL: medium, not `offCurve`; VERIZON WIRELESS PAYMENTS
    (the full name, +$10): `offCurve`;
  - $1,500 plan with a named $1,200 row: low, not `offCurve`;
  - 6 days early and 5 days late match, 11 early and 15 late do not;
  - no name: exact within 3 days is low and never `offCurve`; $23 off or 4 days does not pair;
  - $15.49 Netflix vs a $15.00 Chipotle: low, not `offCurve`;
  - two −$50 rows never pay a −$100 plan;
  - a stop-word is not evidence;
  - a card payment matches a debt minimum by the card name;
  - opposite signs never pair;
  - one to one, with an ambiguous pair kept on the curve;
  - a rejected pair never returns;
  - an income deposit with no name.
- **`__tests__/forecastResolutionsPairs.integration.test.ts` (11):**
  - validation;
  - a rejection survives another match of the plan, and another decision about the row;
  - repeat and second rejections;
  - confirming clears a rejection;
  - partial replaces a match;
  - the unchanged one-per-plan / one-per-row behaviour;
  - the review count with "Not this";
  - partial keeps a reschedule, and a reschedule keeps a partial;
  - rejecting a pair takes back its match.
- **`__tests__/cashSignalProbablyPaid.integration.test.ts` (15).** Balance 1,000.00 read 05-01, today 05-14:
  - $150 paid 8 days early (April paid in April) → `bankToday` 850.00, 05-20 850.00 (not 700.00), 06-20 700.00, and
    the exact match object with `offCurve: true`;
  - $150 paid $173 → 05-20 827.00 (never 677.00), difference 23.00;
  - "Not this" → 05-20 700.00, no match;
  - partial $500 / $250 → 05-20 500.00;
  - partial on a plan moved from the 5th to the 20th → 05-19 750.00, 05-20 500.00;
  - two −$50 rows vs a −$100 plan → 05-20 800.00, no match;
  - a row already matched to another plan → not a candidate;
  - a replaced pending half → the posted row is the match;
  - $1,500 rent vs an unrelated $1,500 Zelle → 05-15 −2,000.00, a low suggestion;
  - $15.49 Netflix vs a $15.00 lunch → 05-15 969.51;
  - "Rent" vs "ZELLE TO PARENTS" → 05-20 −1,700.00, no match;
  - a logged payment plus its ACH vs two card minimums → 05-20 810.00, nothing `offCurve`;
  - April's bill paid 21 days late → May's plan stays: 05-20 700.00;
  - a $120 Verizon Wireless plan and a −130 VERIZON FIOS row → 05-20 750.00, not `offCurve`;
  - April "paid" by a nameless HOME DEPOT −150 and April's real payment 21 days late → May stays: 05-20 700.00.
- **Failing before:** with the reviewed head's source (`3d207e8`: `planMatch.ts`, `index.ts`, `forecastLedger.ts`,
  `cashSignal.ts`, `routes/forecast.ts`) swapped in, **22 of the 42 tests fail**:
  - **on a curve figure:** the Zelle vs rent, Netflix vs lunch, "PARENTS", logged payment plus ACH, and late-payment
    cases (the old code dropped the plan);
  - **on the stored resolutions:** partial keeps a reschedule, a reschedule keeps a partial, rejecting takes back a
    match;
  - **on the new rules:** the whole-word, generic-word and "American Water" evidence tests, the no-name, small-bill,
    underpaid and ambiguous matcher tests;
  - **on the new `offCurve` field or the stricter confidence only:** $150/$150, $150/$173 (both levels), $1,200 vs
    $1,500, the card payment, income.
  - **Still passing on `3d207e8`:** the earlier resolution tests, the earlier curve figures, and the partial on a moved
    plan when both resolutions already exist (the ledger already handled it; the route deleted the reschedule).
  - Against `main` (`56596f3`), the first round's 12 of 28 still hold for the original tests.
  - **Second look:** with `f40c4b0`'s `planMatch.ts` and `forecastLedger.ts` swapped in, all 3 new tests fail —
    Verizon 05-20 870.00 (expected 750.00), HOME DEPOT 05-20 850.00 (expected 700.00), and the Verizon/Amazon unit
    test (`offCurve` true).

## Verification

- **Full API suite:** **128 files, 1078 pass, 7 todo** (`CI=true`; golden compares clean after the re-record).
- **Targeted (second look):** 56 of 56 — `planMatch` 19, probably-paid 15, resolutions 11, golden 11 (compares clean;
  no snapshot change from the full-name rule).
- **Full API suite:** 128 files, 1078 pass, 7 todo before the second look; CI runs the suite on the new head.
- **Web suite:** **119 files, 933 pass**.
- **Workspace typecheck and build:** typecheck clean; workspace build exit 0.
- **Landing bundle guard:** 572.5 KB of 580, unchanged.
- **Codegen:** regenerated after the `offCurve` spec change; committed.

## Left for later

- **PR5b (web):**
  - "Suggested" in Review, with Confirm (`matched`), Not this (`not_match`) and Partial;
  - the new statuses in `forecastMatch.ts` (`rescheduled` is missing there too);
  - the register and `forecastReconcile` read `CashSignal.matches` and skip only `offCurve` plans;
  - remove the bundle filter on `not_match`/`partial`.
- **PR6:** overdue bills now have "probably paid" evidence to lean on; it replaces the pre-snapshot rule (#666) only
  after this.
- **Brad's decision on logged Avalanche payments** vs their bank debits (options a/b/c).
