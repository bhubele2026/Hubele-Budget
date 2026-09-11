# PR5b — "Probably paid" on the Forecast page (web)

Codex work-order point **6** ("probably paid" matching), plan PR5, web half. The server half (PR5a) pairs plans with
bank rows and sends them as `CashSignal.matches`; this PR shows them as "Suggested", with Confirm / Not this /
Partial, and teaches the register the new resolution statuses. Built on `feat/probably-paid-server` (`3d207e8`), then
merged with the PR5a review fixes (`f40c4b0`: `offCurve`, confidence, windows, a `partial` and a `rescheduled` kept
together). Plan: `~/.claude/plans/h2-budget-work-serene-pebble.md`.

| Commit | What it does |
|---|---|
| `e30360a` | Register statuses, "Suggested" on the card and the row, client suggestions step aside, reconcile, tests, e2e. |
| `028ecc3` | This note (first version). |
| merge | `origin/feat/probably-paid-server` @ `f40c4b0`. No conflicts; no codegen needed (the merge brought the regenerated client). |
| final | The bundle's `not_match` / `partial` filter removed, with a server test; Move allowed on a partly-paid plan; note. |

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
  carries two suggestions. `suggestPlanMatchesForBank` skips a `probablyPaid` plan itself. The dropdown and drag
  (manual matching) still reach every open plan.
- **The bucket** lists a `partial` with the part that was settled (planned − remainder), and finds a moved
  occurrence's decision by its original key.

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
  difference, day delta, in or out of forecast), and the three answers in place of Move / Mark missed. A row click
  does nothing. A partly-paid row reads "Partly paid", shows the remainder, and "Paid $X of $Y"; it keeps Move (the
  server keeps the partial beside the reschedule, so the remainder lands on the new date) and has no Mark missed.
- **Answers** post through the generated `useUpsertForecastResolution`:
  - Confirm → `{status: "matched", recurringItemId, occurrenceDate: planDate, matchedTxnId}`;
  - Not this → the same with `not_match`;
  - Partial → the same with `partial`, offered only when the row paid less than the plan by more than $1.

  The page's `invalidate()` refreshes the whole `/api/forecast` namespace (the bundle and the cash signal); the App
  mutationCache adds the spine. Not this and Partial toasts carry Undo.
- **Resolved this month** takes the resolution id from the register, and labels a partial "partial".
- **"Mark N unplanned"** (posted rows with the flag off) leaves out server-paired rows, as it already left out
  transfers.
- **Drag** onto a partly-paid plan is refused ("partly paid").

### e2e

These specs seed a plan and a same-amount row, which the server now pairs whenever the row is dated today or earlier:
- `forecast-inbox-pager` and `forecast-pinned-inbox-collapsed-persistence` accept either suggestion (the client's or
  the server's) for that row.
- `forecast-one-click-match` expects Confirm when the row is dated today or earlier (the month-end clamp to the 28th).
- `forecast-enter-to-match` skips on those days: there is no Enter shortcut on a server pair.

## Deviations

- **"Suggested" is a field, not a plan status.** A suggested plan stays `pending_plan` / `future` with `probablyPaid`
  set. That keeps every existing eligibility check (drop, dropdown, linger on Review, month close) unchanged; the
  chip reads "Suggested".
- **`partial` is a plan status**, and it is not match- or miss-eligible: either write would replace the partial
  resolution server-side and un-pay its row. It **can move** (PR5a's review made a `rescheduled` write keep the
  `partial`). Undo is in "Resolved this month" and the bucket.
- **Suggested rows lose Move / Mark missed and the row click.** Their answers are the three buttons.
- **Keyboard fix in `PlanDropRow`.** Enter or Space on a button inside a plan row used to run the row's own action.
  The row's `preventDefault` cancelled the button, so Enter on "Move to…" marked the plan missed. The row now ignores
  keys aimed at its children.
- **"Mark N unplanned" skips server-paired rows** (above).
- **No new e2e spec for the server path.** e2e could not be run here (below); the server path is covered by the web
  component tests and PR5a's integration tests.

## Figures and screens that should move

- **Review → From Chase, "Forecast $X"** and **Planned items, "Projected end"**: up by every off-curve plan in the
  month. They now agree with the curve. A partly-paid plan counts only its remainder.
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
- **Past-due card and chart tooltip.** Mark missed / Skip there act on the curve's event, so on a partly-paid plan's
  remainder they replace the partial server-side, and the paid row returns to Review. The register itself blocks
  both.
- **Pairs whose plan is outside the bundle window** (the server looks back to today−45, rows to today−59; the bundle
  starts at the first of last month) are ignored on the web. Their row keeps the client's suggestions.
- **An underpaid named pair is on the curve** (`offCurve: false`) until the user answers Partial or Confirm; the strip
  says "Still in forecast". That is PR5a's rule, shown as is.
- **Two queries.** Until the cash signal loads, a row shows the client's suggestions, then switches. A cash signal
  older than the bundle can't resurrect a decided pair (the stale guards above).
- **e2e not run.** Playwright's browsers are installed, but the specs need Clerk (`CLERK_SECRET_KEY`), a running API
  and web server, and a database; none are configured here. The four spec edits are unverified.

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

## Verification

On the merge with PR5a `f40c4b0` plus the bundle-filter removal:
- **Web suite:** **121 files, 980 pass** (`TZ=UTC CI=true`; base 119 / 933; 979 before the partial-Move test).
- **Workspace typecheck:** clean.
- **Build + guard:** build exit 0; landing **572.5 KB of 580**, unchanged; no recharts on open.
- **API suite:** **128 files, 1079 pass, 7 todo** (`CI=true`, own database `h2budget_test_pr5b`, dropped after).
- **Codegen:** not re-run; the merge brought PR5a's regenerated client and spec without conflicts, and no spec
  changed here.

## Left for later

- **An e2e spec for the server path**, run where Clerk and the dev servers are configured.
- **PR6:** overdue bills can lean on "probably paid" before the pre-snapshot rule (#666) is retired.
