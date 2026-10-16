# Auditor S — acceptance matrix, journeys, in-line repairs (2026-10-16)

Branch `cons/s-screens` from `consistency/integration` 2a23019e (= live 1b621c54). Local only. NOT pushed, NOT deployed.
Fixtures only (rich2, zero-rows-today); owner + member; chromium + webkit; 1280 + 390. No real import, no live AI.

## Result in one line
- 12 areas × 7 columns = 84 cells: 75 pass · 6 fail→fixed (repaired, re-walked pass) · 1 FAIL left open (owner call) · 2 blocked
- 7 real defects found and repaired, each with a test and a headless re-walk
- Landing 622,000 bytes (+0 vs 2a23019e; cap 622,000). Per-page `document.title`: blocked, +94 bytes

## Walk method (every cell has an assertion or a shot, none from reading)
- `s-matrix.mjs`: per page, normal load (title, active nav, tab, breadcrumb, endpoint 200, no NaN/undefined/null, no sideways scroll, no 4xx), error (primary endpoint forced to 500), empty (every array in the answer emptied)
  - final: 149 pass / 0 fail × 4 (chromium/webkit × 1280/390) = 596 checks; owner on rich2 + zero, member on rich2
  - walk 1, before any repair (chromium 1280 only): 11 fails = R1 (4 cells), R2 (2), R4 (2), R5 (1) and 2 detector false alarms resolved as documented quiet faces
  - walk 2, after R1–R5, all four combos: 148 pass / 1 fail × 4 (Debt report with balance history failed, then R1 extended)
- `s-scope.mjs`: move off the default, address carries it, reload lands on the same heading — 32/32
- `s-totals.mjs`: what the page prints is in the endpoint's own answer, to the cent — 56/56 (14 ties × 4)
- `journeys-s.mjs` (new), `journeys-e` (5), `journeys-f` (2), `journeys2` (1, 2, 4, 11, 15): tables below
- Shots: `<scratchpad>/preview/shots/s/` (693 files): one per page per browser/width/persona, every error and empty state, `ba/` = before/after of every repaired state

## The matrix
`pass` · `fail→fixed` = failed on the first walk, repaired, re-walked pass · `FAIL` = open · `blocked` = cannot be exercised here

| Area | Primary workflow | Navigation | Data source | Scope kept | Totals vs source | Empty | Error |
|---|---|---|---|---|---|---|---|
| 1 Dashboard | pass — je 1,2,3,5; J6, J12 | pass — "Today · Fri Oct 16", Dashboard lit | pass — spine, position, cash-signal, amex/summary, debts 200 | pass — tile links keep account, week, horizon (je 1,3,5) | pass — Checking today, week counted + unconfirmed, forecast low, Amex Σ cards = their endpoints | pass — 4 sources emptied | pass — spine 500 "Couldn't load these numbers" + Try again; Amex purchases line omitted by design, asserted absent (never $0) |
| 2 Banking review | pass — je 1 bucket → row → register → Back | pass — h1, Banking, tab, "Review" | pass — /banking/review | pass — ?from&to survives reload; account kept (je 1) | pass — balance = review `balance.today` | pass | pass |
| 3 Chase register | pass — je 1 | pass — h1 "Chase", Banking, tab "Chase register" | pass — /transactions/ledger | pass — ?mode=month survives reload | pass — Out, Net, START = the ledger's totals | pass | pass |
| 4 Amex cards (all, card 1, card 2) | pass — je 2; jf 1,2; J2 | pass — Amex lit, card tab lit, crumb "All cards" / card | pass — /amex/summary | pass — ?card kept; ?month survives reload | pass — Owed, Purchases = summary | pass ×3 pages | pass ×3 pages |
| 5 Weekly spending | pass — je 3; jf | pass — "This week · Sun–Sat", tab | pass — /money/period-breakdown | pass — ?start survives reload | pass — counted, unconfirmed = breakdown | pass | pass |
| 6 Monthly allowance | pass — je 4 | pass | pass — period-breakdown month | pass — ?start survives reload | pass — spent = breakdown actual | pass | pass |
| 7 Budget + allowances | pass — J8, J9 | pass — Budget / Allowances, tab, crumb | pass — budget/months, allowance-plans, period-breakdown | pass — ?month survives reload; "Where it went" carries ?start (J9) | fail→fixed — see R6, R7 | pass | pass |
| 8 Forecast overview, detail, reconciliation | pass — je 5 | fail→fixed — overview had no title (R3) | pass — cash-signal, /forecast | pass — ?horizon survives reload; day kept (je 5) | pass — low, runway, Checking today = spine = cash signal (3 pages) | pass | fail→fixed — R2 |
| 9 Debt planning (plan, Debts, report) | pass — J6 | pass — Debt lit, tabs, crumbs | pass — /debts, balance-history, debt-plan | pass | pass — every balance = /debts; Reports total = Σ active | pass | fail→fixed — R1 |
| 10 Reports (hub + 5) | pass — J7 | pass | pass — spending-facts, budget-facts, behavior-facts, transactions | FAIL — hub says "Last 30 days", the report opens on its own week; range is not in the address (owner call, below) | pass — hub tile and report total each in their own source | pass | fail→fixed — R4 |
| 11 Mapping rules + imports | blocked — walked: J10 dry-run preview, J14 add rule (pass); blocked: workbook import dry run | pass | pass — /mapping-rules | pass | pass — preview count = the fixture's uncategorized matches | pass | fail→fixed — R5 |
| 12 AI categorization + morning recap | blocked — walked: J13 change → filed → Undo, J12 recap (pass); blocked: accept a suggestion | pass | pass — categorization/review, agent/proposals, recap/preview | pass | pass — J12 recap ties to its own facts, the badge and the forecast tile | pass | pass |

Blocked cells (2: the primary-workflow cells of rows 11 and 12; the rest of each row passes)
- Imports workflow: `POST /import/workbook` has no dry-run mode (it writes); only the control was checked (J11), nothing uploaded
- Accept-a-suggestion leg: the fixture provider suggests no category (`suggested 0`, `modelQueued 0`); Change → filed → Undo was walked instead

## Defects found and repaired (each with a test)
| # | Found (matrix cell) | Repair | Test |
|---|---|---|---|
| R1 | A failed debts read printed "No debts recorded" and zero tiles (Debts), "0 active · Add a debt to see which one dies first" (Payoff plan), "0.0% paid off" when only balance history failed (Debt report) | Title kept, "Couldn't load your debts." + Try again; the report needs both reads | `debtsLoadFailed.test.tsx` (2), `reportsRender.test.tsx` (2); headless error cells, 4 browsers/widths |
| R2 | Forecast + To review: a failed first read left no title and a skeleton pulsing under the error | Screen title shown while loading and on failure; no skeleton on failure | `forecastAccuracy.test.tsx` (1 new) |
| R3 | Forecast overview had no h1 at all (title, nav and breadcrumb only on screen) | One screen-reader h1 "Forecast overview" (`sr-only`, no restyle) | `forecastOverview.test.tsx` (1 new) |
| R4 | Spending report: failed read = skeleton forever. Cash flow report: failed read = "Savings rate 0%, Income $0.00" | "Couldn't load the spending report / your transactions." + Try again, report title kept | `spendingTotalHint.test.tsx` (1), `cashFlowForecastMissing.test.tsx` (1) |
| R5 | Mapping rules: a failed read read "No rules yet. Categorizing a transaction creates one." | Failure message with Try again in the rules panel; Add and Test stay | `mappingRulesLayout.test.tsx` (1) |
| R6 | Allowances weekly card $1,896.51 beside Spending's "Counts toward plan $596.32": two measures, one name (`actual` includes unconfirmed rows) | Under the card: "Counts toward plan $X · unconfirmed $Y. Where it went" (server's own `known` and `unresolved`; link keeps `?start`); in the open bucket: "Rows filed to a weekly bucket. Unfiled and unconfirmed rows: This week". Figures unmoved | `allowancesKitRestyle.test.tsx` (2); J9 |
| R7 | Budget "Spent" drill listed a refund row the figure does not count (head $2,283.80, running total $2,260.81) | Credit on a spending line reads "· credit, not in the figure" (income lines untouched; server's outflow rule) | `budgetPendingOnce.test.tsx` (1); J8 |

Placement note: the failed-read message is defined next to pieces each page already loads (`debt-plaid-link.tsx` for both debt pages, `reportsShared.tsx` for the three reports, inline in mapping rules). A shared module of its own added a chunk to the route map in the landing bundle (+147 bytes with the titles); the landing has zero headroom.

Detector notes (not defects)
- Dashboard: Amex purchases line vanishes when `/amex/summary` fails — documented ("never $0"); asserted absent
- Reports hub: Total debt shows "—" when `/dashboard` fails — the missing face; asserted

## Measure labels (item 4)
- Allowances weekly figure vs Spending "Counts toward plan": labelled both, linked to This week (R6)
- Budget drill running total vs head figure: credit row labelled (R7)
- Review badge: already says "13 to review: 11 charges to match, 2 categories to confirm" (title and aria); the "36 vs 2" scope is named
- Not changed, named for the owner: Reports hub "Amex (Blue Cash + Platinum)" counts only cards it recognises by name/mask (`lib/reportsBalances.ts`); on the fixture it shows Platinum alone ($2,340.55) while the dashboard Amex tile sums both ($2,952.85); the sub-line names the card counted

## Per-page `document.title`
- Measured: blocked — +94 bytes (shared hook chunk adds route-map entries) and +176 bytes (one effect in the shell) over a landing that is exactly 622,000 bytes
- Built, measured, reverted. Needs 176 bytes trimmed from the landing first. Every page still shares "H2 Budget — Family Finance"; h1, nav, tab and breadcrumb name the place (asserted in every cell)

## Journeys (pass counts; both fixtures where two are shown)
| Journey | chromium 1280 | chromium 390 | webkit 1280 | webkit 390 |
|---|---|---|---|---|
| 1 Dashboard → Banking → Not in the plan → row → Back | 2/2 | 2/2 | 2/2 | 2/2 |
| 2 Dashboard → Amex → card → row Details → Back | 2/2 | 2/2 | 2/2 | 2/2 |
| 3 Dashboard → This week → Breakdown (updated for 2a23019e: opens the Amex reconciliation, `?open=amex`) | 2/2 | 2/2 | 2/2 | 2/2 |
| 4 Dashboard → Monthly allowance → Details → rows → Back | 2/2 | 2/2 | 2/2 | 2/2 |
| 5 Dashboard → Forecast low point → day → row → Back | 2/2 | 2/2 | 2/2 | 2/2 |
| 6 Dashboard → Debt → a debt's details (Edit debt) → Esc → Debts tab → Debt report → Back ×3 | 2/2 | 2/2 | 2/2 | 2/2 |
| 7 Reports → Spending report → its rows (uncategorized list) → Back | 2/2 | 2/2 | 2/2 | 2/2 |
| 8 Budget → a line → its rows → drill (month + line kept) → Back | 2/2 | 2/2 | 2/2 | 2/2 |
| 9 Allowances → week cycler → measure line → This week (same week) → Back | 2/2 | 2/2 | 2/2 | 2/2 |
| 10 Mapping rules → pattern → rows it would affect (dry run, 0 writes) | 2/2 | 2/2 | 2/2 | 2/2 |
| 11 Imports → Settings › Data upload control (not exercised, 0 writes) | 2/2 | 2/2 | 2/2 | 2/2 |
| 12 Morning text → its figures vs its facts, the badge, the forecast tile | 2/2 | 2/2 | 2/2 | 2/2 |
| 13 Categories to confirm, fixture provider (MUTATES, fixture): queue → Change → filed → Undo | 1/1 | — | — | — |
| 14 Mapping rules, add a rule (MUTATES, fixture) | 1/1 | — | — | — |
| journeys-f 1, 2 (Amex line → Breakdown → group → row → pinned → Back) | 2/2 | 2/2 | 2/2 | 2/2 |
| journeys2 1, 2, 4, 11, 15 | pass | pass | pass | pass |

- journeys-e: 40/40; journeys-f: 8/8; journeys2: 20/20; journeys-s 6–12: 56/56; 13–14: 2/2 (chromium 1280, zero fixture)
- Every step asserts title, active nav, tab, breadcrumb leaf, kept params, Back (URL and scroll)
- Journeys 13, 14 write to the fixture DB only (zero-rows-today), last, once

## Gates (worktree `build-s-screens`, final source)
| Gate | Result |
|---|---|
| typecheck | pass |
| web vitest, TZ=America/Chicago | 286 files · 2,946 passed · 0 failed · 2 skipped |
| web vitest, TZ=UTC | 286 files · 2,945 passed · 0 failed · 3 skipped |
| build + entry graph | landing 622,000 bytes (622.0 KB) of 622,000 — +0 vs 2a23019e; no recharts, react-dom confined, virtualizer off the open path |
| API vitest | not run — no server file touched (the money auditor's files untouched) |
| codegen drift | not run — spec unchanged |
| pnpm audit | not run |
| axe | not run |

Tests added: 12 across 10 files (`debtsLoadFailed` new file; the rest appended to existing files). Two tests of an earlier title/shared-component design were deleted with that design.

## Deviations from the brief
- `journeys-e` journey 3 asserted the old Amex line words and a scroll-to-Breakdown that 2a23019e replaced; updated in the scratchpad copy `journeys-e-s.mjs` (the new behaviour is asserted instead). 8 of 40 failed before that edit; the app was right
- The failed-read message is not one shared component (landing cost), see placement note
- Journey 13 stops short of "accept": the fixture provider offers nothing to accept
- Error states are forced by Playwright route interception (the kit has no `FIXTURE_FAIL`)

## Doubts for the owner
- Reports: the hub tile says "Last 30 days $3,532.01"; the report opens on a week ("Oct 9–16 $1,033.11"). Both labelled and each ties to its source. Making the window travel needs the range in the address on 5 reports — a design call, not made
- Undo in Categories to confirm restores the row to unfiled but does not return it to the review queue (`undoDecision` resolves the decision); the row stays visible as "Not filed yet". Server design, not changed
- Recap line "Checking covers $0 until Fri" (money available until payday, degraded by the failed sync) sits beside "Checking today $2,985.00" on the same screen. Different measures, not forced to match; the sentence is the server's
- Debt plan targets "Amex Platinum" (archived, shown "—" on Debts) while the dashboard Amex tile lists it owed $2,340.55. Fixture shape; the money auditor owns debt-vs-Amex agreement
- Fixture recap facts show `categorizationReviewCount 0`: the fixture server never registers the counter that `index.ts:102` registers in production; not an app defect, not verified on real data
- Reports hub Amex tile counts only cards it recognises by name and mask (above)
- Landing has no headroom (622,000 of 622,000): any landing word or title needs 176+ bytes trimmed first

## Not done
- API suites, audit, axe, codegen drift (nothing in scope changed them)
- Real-data walk (fixtures only, by the brief)
- Workbook import dry run (does not exist)
- Live comparison table (the money auditor's)
