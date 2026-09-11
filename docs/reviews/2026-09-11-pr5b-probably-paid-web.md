# PR5b — "Probably paid" on the Forecast page (web)

Codex work-order point **6** ("probably paid" matching), plan PR5, web half. The server half (PR5a) pairs plans with
bank rows and sends them as `CashSignal.matches`; this PR shows them as "Suggested", with Confirm / Not this /
Partial, and teaches the register (and the Chase page's per-row read) the new resolution statuses. Built on
`feat/probably-paid-server` (`3d207e8`), merged with the PR5a review fixes (`f40c4b0`), then — after an independent
review of `82a9836` (REQUEST CHANGES) — merged with `origin/main` @ `9923add` (PR4e follow-ups, PR13 ledger API, PR5a
final with the stricter full-name `offCurve`). Plan: `~/.claude/plans/h2-budget-work-serene-pebble.md`.

| Commit | What it does |
|---|---|
| `e30360a` | Register statuses, "Suggested" on the card and the row, client suggestions step aside, reconcile, tests, e2e. |
| `028ecc3` | This note (first version). |
| `364f0a4` | Merge `origin/feat/probably-paid-server` @ `f40c4b0`. No conflicts. |
| `ffaf7fb` | The bundle's `not_match` / `partial` filter removed, with a server test; Move allowed on a partly-paid plan. |
| `82a9836` | Note: merge, final gates. **Reviewed: REQUEST CHANGES.** |
| `793cb02` | Merge `origin/feat/probably-paid-server` @ `bcc3ea9` (stricter `offCurve`). No conflicts; no fixture changed. |
| `d3de6ec` | Review fixes, part 1 (H1, H2, M1, LOW 1–2, NIT). |
| `67d4d75` | Merge `origin/main` @ `9923add`. No conflicts; codegen re-run: no diff. |
| `c1a0259` | Review fixes, part 2: tests, deterministic e2e, server-path e2e spec. |
| final | This note: "Review fixes", final gates. |

## The problem

**The server now takes a probably-paid plan off the curve, but the Forecast page doesn't know.**
- The register still lists that plan as "Pending plan" or "Upcoming"; nothing on screen says a bank row paid it, and
  there is no way to confirm or reject the pair.
- The web runs its own suggestion rules, so one plan could carry the server's pair and a different client pick.
- `forecastReconcile` still adds the plan into the Review header's "Forecast" end figure, so that figure and the
  curve disagree by the plan's amount.
- The register reads resolutions "last write wins", per plan key and per row. PR5a keeps a "Not this" answer beside
  the real decision (and a `partial` beside a `rescheduled`), so a rejection listed after a row's match would hide
  the match: the row goes back to "pending", and the resolved list's Undo points at the rejection instead of the
  match. PR5a's review therefore kept `not_match` / `partial` out of the `GET /forecast` bundle until this PR.
- `ResolutionStatus` had no `rescheduled`, `not_match` or `partial`.

## What changed

### The register (`lib/forecastMatch.ts`)

- **`not_match`** decides neither side. It never enters the per-plan / per-row maps; it only records the rejected
  pair. The plan and the row stay open, and a real match, ignore, miss or skip is never hidden behind it.
- **`partial`** marks its row `matched` and its plan `partial`. The plan line's `amount` is the unpaid remainder
  (`partialRemainder`, the server ledger's rule: plan − paid; $1 or less, or a flipped sign, leaves nothing; an
  unknown paid amount leaves the whole plan). `plannedAmount` and `paidAmount` carry the rest. The paid amount comes
  from the row, or from the resolution's `txnAmount` when the row is not in the list. A remainder of 0 leaves the
  register.
- **`rescheduled`** is read into its own map. A move and a decision can coexist for one occurrence (a `partial` keeps
  its `rescheduled` row): the move sets the date, the decision the status. The pre-PR5 lookup of a decision keyed on
  the new date is kept.
- **Server pairs** (`matches` option). An open (pending or upcoming) plan named by a match carries `probablyPaid`
  (row id and date, amount, difference, day delta, confidence, ambiguous, `offCurve`, description); its pending row
  carries `suggestedPlan`. A pair is ignored when the client already knows better: the plan is resolved, the row is
  claimed by any resolution, or the pair was rejected. Pairs are kept one to one. A missing `offCurve` counts as on
  the curve, so a missing flag can never hide a bill.
- **The no-bank running balance** skips an off-curve plan, as the curve does.
- **`buildClientSuggestions`**: the client scorers skip every plan and every row the server paired, so a plan never
  carries two suggestions. `suggestPlanMatchesForBank` skips a `probablyPaid` plan itself. **(Review H1)** They also
  skip every pair the user answered "Not this" — `buildLineRegister` now returns `rejectedPairs` — so no chip,
  one-click Match, Enter shortcut or "Match all confident" re-offers it. The dropdown and drag (manual matching)
  still reach every open plan.
- **Review linger (review M1):** a past-due partly-paid plan with a remainder stays on Review's register, as a
  past-due pending plan does; the forward Forecast view still drops it.
- **The bucket** lists a `partial` with the part that was settled — what the row actually paid when known (review
  NIT: a ≤ $1 shortfall no longer shows the full plan), else planned − remainder — and finds a moved occurrence's
  decision by its original key.

### The bundle (`routes/forecast.ts`, the one server change)

- The `(PR5)` filter that kept `not_match` and `partial` rows out of `GET /forecast`'s `resolutions` is removed; the
  register above reads them. No money logic moves: the curve, the matcher and the resolution writes are PR5a's.
- `forecastResolutionsPairs.integration.test.ts` gains a bundle test: `not_match(P,T1)` + `matched(P,T2)` and a
  `partial` + `rescheduled` for one occurrence all come back.

### `offCurve` (PR5a review contract)

- `offCurve` is true only for a named, unambiguous pair where the row paid no less than plan − max($1, 1%) and no
  more than plan + max($25, 10%); a later occurrence stays on while an earlier one of the same item is unpaid.
- The web treats only `offCurve === true` as off the curve. Confidence is shown as a word and drives nothing: a
  "medium" pair can be on or off the curve, and the strip says which ("Out of forecast" / "Still in forecast").

### `forecastReconcile`

- Skips a plan only when `probablyPaid.offCurve`; a suggestion kept on the curve still counts.
- A `partial` line adds its remainder (its `amount`), so "Forecast" agrees with the curve. A partial is not
  matched-amount drift.

### The Forecast page

- **Inbox card (Review).** A row the server paired shows the "Suggested" strip under the card instead of the client's
  chips:
  - the plan, its date and amount;
  - the difference ("$23.00 over" / "under" / "exact");
  - the day delta ("8d early" / "late" / "same day");
  - the confidence word, "close call" when ambiguous;
  - "Out of forecast" or "Still in forecast";
  - Confirm, Not this and Partial, with the explanation in a `Help` chip.

  Figures are mono; the words carry the state. The card's client one-click Match, its Enter shortcut and the drag
  hint are off for that row. The collapsed pinned row's Match confirms the server pair.
- **Register row (both pages).** Chip "Suggested", then a line with the paying row (description, date, amount,
  difference, day delta, in or out of forecast), and the three answers. **An off-curve pair** shows them in place of
  Move / Mark missed, and a row click does nothing. **(Review LOW 2)** A pair still counted on the curve keeps Move,
  Mark missed and the row click beside the answers. A partly-paid row reads "Partly paid", shows the remainder, and
  "Paid $X of $Y"; it keeps Move (the server keeps the partial beside the reschedule, so the remainder lands on the
  new date) and has no Mark missed.
- **Past due card and chart tooltip (review M1).** A partly-paid plan's remainder is dragged onto tomorrow by the
  curve. Both surfaces now look the plan up in the register (`partialPlanKeys`): the card shows "Partly paid" instead
  of Mark missed / Skip / "Mark matched to…", and the tooltip hides its Mark missed. `onMarkMissed` and
  `onSkipDraggingPlan` also refuse a partial, whatever surface calls them. Undo of the partial stays in "Resolved this
  month" and the bucket.
- **Answers** post through the generated `useUpsertForecastResolution`:
  - Confirm → `{status: "matched", recurringItemId, occurrenceDate: planDate, matchedTxnId}`;
  - Not this → the same with `not_match`;
  - Partial → the same with `partial`, offered only when the row paid less than the plan by more than $1.

  The page's `invalidate()` refreshes the whole `/api/forecast` namespace (the bundle and the cash signal); the App
  mutationCache adds the spine. Not this and Partial toasts carry Undo.
- **Resolved this month** takes the resolution id from the register, and labels a partial "partial".
- **Bulk "unplanned" (review LOW 1).** All three actions — "Mark N unplanned" (posted rows with the flag off), "Mark
  all unplanned" and "Mark N unplanned" on selected rows — leave out server-paired rows, as the first already left
  out transfers.
- **Drag** onto a partly-paid plan is refused ("partly paid").

### The Chase / Transactions page (`pages/transactions.tsx`, review H2)

Only the forecast-resolution lookups changed; the Chase list's data source, totals and balances are untouched (PR14
rebuilds that list).
- The per-row read is `rowDecisionsByTxn` (`lib/forecastRowState.ts`): it ignores `not_match`, so a rejection beside a
  real match can't hide it (in either order), and a row whose only answer is a rejection is still "In Review".
- A `partial` shows "Partly paid" and offers no "×" — every write that chip could make would replace the partial.
- The bulk Remove (`bulkSetForecast`) records "not a planned payment" for a posted row whose only answer is "Not
  this", and never for a partly-paid row.

### e2e

- **Client-path specs** (`forecast-one-click-match`, `forecast-enter-to-match`, `forecast-inbox-pager`,
  `forecast-pinned-inbox-collapsed-persistence`) seed the bill on the 20th of the current month and the paying row,
  for the exact amount, on the 16th (the contested case adds the 24th). The row's description shares no word with the
  bill's name. The client calls that a high-confidence one-click match (exact amount within 5 days); the server can
  never pair it (without the name it needs ≤ 3 days). Each spec takes exactly one path on every calendar day, in any
  time zone: the original assertions are restored, the date branch and the skip are gone, and the one-click and
  pinned specs also assert that no "Suggested" strip appears.
- **New `forecast-probably-paid.spec.ts`** covers the server path: seeded on the household date (the server's `today`
  from `GET /api/forecast`, browser in `America/Chicago`), a bill "Aqualine <tag>" and a row "AQUALINE <TAG> WEB" for
  the same amount on the same day. Suggested → Confirm (POST body, toast, Resolved list, persisted `matched`), and
  Suggested → Not this (POST body; strip gone, row still in Review with no chips, no one-click, no Enter wrapper, no
  "Match all confident"; cash signal no longer pairs it; only the `not_match` persisted).
- `bulk-match-confident` needed no change: its rows are strictly future, which the server never pairs.

## Deviations

- **"Suggested" is a field, not a plan status.** A suggested plan stays `pending_plan` / `future` with `probablyPaid`
  set. That keeps every existing eligibility check (drop, dropdown, linger on Review, month close) unchanged; the
  chip reads "Suggested".
- **`partial` is a plan status**, and it is not match- or miss-eligible: either write would replace the partial
  resolution server-side and un-pay its row. It **can move** (PR5a's review made a `rescheduled` write keep the
  `partial`). Undo is in "Resolved this month" and the bucket.
- **Off-curve suggested rows lose Move / Mark missed and the row click.** Their answers are the three buttons. A
  suggestion still counted on the curve keeps them (review LOW 2).
- **A partly-paid plan's past-due remainder is not actionable from the Past due card or the tooltip** (review M1). The
  alternative — making Undo restore the partial — would need the server to remember what a skip replaced; hiding is
  simpler and loses nothing (Undo of the partial is in Review).
- **Keyboard fix in `PlanDropRow`.** Enter or Space on a button inside a plan row used to run the row's own action.
  The row's `preventDefault` cancelled the button, so Enter on "Move to…" marked the plan missed. The row now ignores
  keys aimed at its children.
- **Bulk "unplanned" skips server-paired rows** (above).

## Review fixes (independent review of `82a9836`, REQUEST CHANGES)

| Finding | Fix | Tests |
|---|---|---|
| **H1** "Not this" doesn't stick: the client re-offered the rejected pair (one-click, Enter, "Match all confident"), and a bulk click wrote `matched`, deleting the rejection. | `buildLineRegister` returns `rejectedPairs`; `buildClientSuggestions` skips them (keyed on the original occurrence). Dropdown still lists the row. | `forecastProbablyPaid.test.ts` "(PR5b review H1)" ×3; `forecastProbablyPaid.test.tsx` "(review H1)". |
| **H2** Transactions page read `partial`/`not_match` last-write-wins; its "×" deleted a partial; `not_match`-only rows counted as decided. | `rowDecisionsByTxn` (ignores `not_match`); `partial` = "Partly paid", no removal; bulk Remove targets `not_match`-only rows, never partials. | `forecastRowState.test.ts` ×3; `chaseForecastInclusion.test.tsx` ×4 (partial posted, partial future, rejection beside match in both orders, bulk Remove). |
| **M1** Past-due partial vanished from Review; Past due card / tooltip actions destroyed it; Undo lost it. | Review register lingers a partial with a remainder; `partialPlanKeys` hides Mark missed / Skip / "Mark matched to…" on the card and Mark missed in the tooltip; handlers refuse a partial. | `forecastProbablyPaid.test.ts` linger ×2; `forecastProbablyPaid.test.tsx` "(PR5b review M1)" ×2 (Review register; Past due card — nothing to Skip, so no Undo can lose it); `ProjectedBalanceChart.test.tsx` ×2. |
| **M2** e2e edits weakened assertions; one skipped on days 28–31; one compared the machine date with the household date. | Deterministic client-path seeds (see e2e); original assertions restored; no skip, no date branch; new server-path spec on the household date. | e2e only (not runnable here; `typecheck:e2e` clean). |
| **LOW 1** Two bulk "unplanned" actions still swept server-paired rows. | All three skip `suggestedPlan` rows. | `forecastProbablyPaid.test.tsx` "(review LOW) 'Mark all unplanned'…". |
| **LOW 2** Counted suggestions (`offCurve: false`) lost Move / Mark missed. | Only an off-curve suggestion hides them (and the row click). | `forecastProbablyPaid.test.tsx` "(review LOW) a suggestion still counted…". |
| **LOW 3** Partial-Move test passed on PR5a's head. | Asserts "Partly paid" and that the Move dialog carries the $500 remainder, not $1,500. | `forecastMissedActions.test.tsx` "(PR5) Move on a partly-paid row…" — now fails with `3d207e8`'s web files. |
| **LOW 4** Missing tests. | All of the above. | — |
| **LOW 5** Note overstated "now agree with the curve". | Softened below; the snapshot-day case listed as a residual (PR6's area, not fixed here). | — |
| **NIT** Chip comment wrong for counted suggestions; ≤ $1 partial showed the full plan as settled. | Comment corrected; bucket shows the paid amount. | `forecastProbablyPaid.test.ts` "the bucket shows what a partial actually paid…". |

**PR5a head `bcc3ea9`** (stricter `offCurve`): merged, then superseded by `origin/main` `9923add`. The web contract is
unchanged and no fixture needed to change.

## Figures and screens that should move

- **Review → From Chase, "Forecast $X"** and **Planned items, "Projected end"**: up by every off-curve plan in the
  month, and a partly-paid plan counts only its remainder. The reviewer seeded 8 scenarios through the real API and
  the web month-end figure equalled the server curve to the cent in all of them; it is not equal in every case (see
  the snapshot-day residual).
- **Register rows:** "Suggested" instead of "Pending plan" / "Upcoming" for paired plans; "Partly paid" with the
  remainder for partial ones.
- **Inbox:** the Suggested strip replaces the client chips on paired rows. "Match all confident (N)" and the one-click
  Match can drop, because a server-paired plan or row is no longer a client pick.
- **Review bucket / Resolved this month:** partial rows appear.
- **Unchanged:**
  - the curve, hero, KPIs, "Matched impact" (`acceptedImpact`), low point, and chart — all server figures;
  - the spine and review count;
  - landing (`/home`) — no dollar figures, no new import;
  - every plan and row the server did not pair.

## Must not change

- Landing shows no dollar figures; the landing bundle stays within its cap (572.5 KB of 580, unchanged).
- No new dependencies. No server money logic (PR5a owns the matcher, the curve and the remainder).
- `acceptedImpact` is read, never computed, on the web (tested: identical with and without matches).

## Residuals

- **The remainder rule is duplicated.** `partialRemainder` mirrors the server ledger's inline rule; a change there
  must change both. It is pinned by a unit test.
- **A partly-paid plan's remainder can't be matched to a second row.** The server keeps one decision per plan; a
  second match would replace the partial. Undo the partial first.
- **Snapshot-day plans (pre-existing, review LOW 5).** `forecastReconcile` leaves out plans dated on or before the
  snapshot day, while the server still carries the day-before-snapshot expense forward (#688). In the reviewer's D2
  case the web "Forecast" showed 1000.00 against the curve's 750.00. PR6 reworks that rule, so it is not changed here.
- **Pairs whose plan is outside the bundle window** (the server looks back to today−45, rows to today−59; the bundle
  starts at the first of last month) are ignored on the web. Their row keeps the client's suggestions.
- **An underpaid named pair is on the curve** (`offCurve: false`) until the user answers Partial or Confirm; the strip
  says "Still in forecast". That is PR5a's rule, shown as is.
- **Two queries.** Until the cash signal loads, a row shows the client's suggestions, then switches. A cash signal
  older than the bundle can't resurrect a decided pair (the stale guards above).
- **e2e not run.** Playwright's browsers are installed, but the specs need Clerk (`CLERK_SECRET_KEY`), a running API
  and web server, and a database; none are configured here. The four spec edits and the new spec are verified only
  by reading and by `typecheck:e2e`. Two assumptions a run would test: the matcher's "no name ⇒ ≤ 3 days" rule (the
  client-path seeds rely on it), and that a monthly bill created today has an occurrence today in the Review cash
  signal (the server-path spec relies on it).
- **The Past due card shows a partly-paid remainder with no action.** Resolving it means undoing the partial in
  Review first.

## Tests

- **`lib/forecastProbablyPaid.test.ts` (27):**
  - `not_match`: open on both sides; a rejection after a match, after an ignore, after a miss; no bucket row;
    `not_match(P,T1)` + `matched(P,T2)`;
  - `rescheduled`: a rejection on the original key keeps the move;
  - `partial`: row matched and remainder planned; ≤ $1 leaves the register; paid amount from the resolution;
    unknown paid keeps the plan; the bucket's settled part; a partial beside its move, in both orders;
    `partialRemainder`; `canRecordPartial`;
  - server pairs: attach to plan and row; moved plan keyed on the original date; ignored when the plan is resolved,
    the row claimed or the pair rejected; one to one; a row outside the list; off-curve left out of the running
    balance; kept-on-curve still counts; missing `offCurve` = on the curve;
  - no duplicates: `buildClientSuggestions`, one-click and confident picks never reach a server-paired plan; the
    scorer skips it; control without matches.
- **`pages/forecastProbablyPaid.test.tsx` (10):**
  - Suggested strip: text, mono figures, no client chips / one-click / drag hint;
  - register row: "Suggested", paying row, answers, no Move / Mark missed, row click writes nothing;
  - Confirm, Not this and Partial post the right bodies, from the card and the register;
  - an answer invalidates the cash-signal key;
  - no duplicate suggestions (confident count, t-dup, t-other keeps its pick);
  - "Projected end" leaves out only the off-curve plan;
  - in/out-of-forecast words;
  - "Matched impact" identical with and without matches.
- **Added to existing files (10):**
  - `forecastReconcile` (3): skips off-curve; counts kept-on-curve; partial remainder through the register;
  - `forecastSkipped` (1): a later "Not this" doesn't bring a skipped row back;
  - `forecastOneClickMatch` (1): no one-click pick for a server-paired plan;
  - `forecastOneClickMatchButton` (1): a server-paired card has Confirm, no Match, no Enter;
  - `forecastDragMatch` (1): drop onto a partly-paid row is refused;
  - `forecastMissedActions` (3): a Suggested row has no Mark missed / Move; a partly-paid row has no Mark missed; a
    row click writes nothing on either; Move on a partly-paid row posts `rescheduled` for the original occurrence.
- **Server (1):** `forecastResolutionsPairs.integration.test.ts` — the bundle returns `not_match`, `matched`,
  `partial` and `rescheduled` rows for the same plans.
  - No existing assertion was changed or removed. Two page-test mocks now read a per-test cash signal / bundle,
    reset in `beforeEach`.
- **Failing before:** with `3d207e8`'s seven source files (`forecastMatch.ts`, `forecastReconcile.ts`, `forecast.tsx`,
  `InboxCardView.tsx`, `PlanDropRow.tsx`, `PlannedItemsList.tsx`, `statusBadge.tsx`) swapped in, **42 of the 46 new
  tests fail**:
  - **Still passing on the base (4):** "`not_match` produces no bucket row", "ignored when the plan is resolved",
    "ignored when the row is claimed or the pair rejected", and "still counts a suggestion kept on the curve". They
    pin behaviour the base already had, since it ignored matches.
  - **Failing only because a new export is missing (5):** `partialRemainder`, `canRecordPartial`, the scorer
    control, and the `buildClientSuggestions` one-click test in `forecastOneClickMatch`. Their behaviour is new.
  - The partial-Move page test was added after this proof and is not in the 42 / 46.
  - **Server bundle test:** with the merge commit's `routes/forecast.ts` (the filter still in) swapped in, the new
    bundle test fails and the file's other 11 pass.
- **Review-fix tests (20 new, 1 strengthened):**
  - `lib/forecastProbablyPaid.test.ts` (+6): H1 ×3, M1 linger ×2 (partial lingers; a settled one does not), NIT bucket.
  - `lib/forecastRowState.test.ts` (3, new module).
  - `pages/chaseForecastInclusion.test.tsx` (+4): H2.
  - `pages/forecastProbablyPaid.test.tsx` (+5): H1, LOW 1, LOW 2, M1 ×2.
  - `pages/forecast/ProjectedBalanceChart.test.tsx` (2, new): M1 tooltip, and its control.
  - `pages/forecastMissedActions.test.tsx`: the partial-Move test strengthened (LOW 3).
- **Review fixes failing before:** with `82a9836`'s `forecastMatch.ts`, `forecast.tsx`, `PlanDropRow.tsx`,
  `ProjectedBalanceChart.tsx`, `statusBadge.tsx` and `transactions.tsx` swapped in (main had not changed any of them),
  **15 of the 20 new tests fail**. Still passing: the 3 `rowDecisionsByTxn` unit tests (a new module the swap does
  not remove — the H2 page tests are the proof), "a settled partial does not linger" and the tooltip control, both
  pinning behaviour that already held. The strengthened partial-Move test passes on `82a9836` (which already read
  partials) and now **fails** with PR5a head `3d207e8`'s seven web files swapped in (the base the reviewer meant).

## Verification

On the merge with `origin/main` `9923add` plus the review fixes:
- **Web suite:** **123 files, 1000 pass** (`TZ=UTC CI=true`; 121 / 980 before the review fixes; base 119 / 933).
- **Workspace typecheck:** clean; `typecheck:e2e` clean.
- **Build + guard:** build exit 0; landing **572.5 KB of 580**, unchanged; no recharts on open.
- **API suite:** **129 files, 1105 pass, 7 todo** (`CI=true`, own database `h2budget_test_pr5b`, dropped after).
- **Codegen:** re-run after the `origin/main` merge: no diff.

## Left for later

- **Run the e2e suite** where Clerk and the dev servers are configured, including the new server-path spec.
- **PR6:** overdue bills can lean on "probably paid" before the pre-snapshot rule (#666) is retired.
