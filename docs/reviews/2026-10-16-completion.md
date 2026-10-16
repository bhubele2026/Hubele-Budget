# Completion pass on the live d15dc56 — handoff (2026-10-16)

Branch `consistency/integration` (worktree `/private/tmp/claude-501/cons-int`), from d15dc56e (LIVE). Builder notes:
`2026-10-16-d-money.md` (items 1–2), `2026-10-16-e-screens.md` (items 3–5).
**Status: built locally and verified on synthetic fixtures. NOT pushed. NOT deployed.**

## 1. Root causes and fixes
- **Balance not auditable.** The explain route computed "rows since the reading" with the ledger's rule but returned
  only a count and a net. Fix: the response carries every row the ledger read with the rule's own verdict
  (`reason`, `counted`, `contribution`, `onAccount`); Details lists the counted rows (date · description · signed amount
  · Pending/Posted · link to the row), the sum line "Bank's last reading $X + N rows = Checking today $Y" (shown only
  when it ties to the cent), "Estimate: N pending rows" when any counted row is pending, and "Not counted (n)" with the
  reason word. One rule, no second implementation. Trace table (ten questions) in `docs/contracts/checking-balance.md`.
  **Live finding:** the two rows behind the owner's figure are both dated the day after the $0 reading and both pending
  (a deposit in, a charge out); they are counted because a pending deposit is never inside the bank's `available`
  figure. Whether they post at the same amounts cannot be verified from here; Details now says "Estimate".
- **Register row headlined the stored item amount.** The owner's Monthly Spend item is stored at one figure (an old
  template) while his monthly plan is another; the forecast uses the plan. Fix: Weekly/Monthly Spend rows headline the
  figure the forecast takes for that occurrence (cash signal, by occurrence key); the running balance and sums use it;
  a row off the curve shows "—"; the item amount sits behind the row's Details as "a template; the forecast uses the
  plan". The saved item is unchanged. Day panel = register = curve step (tested).
- **Partial answer on a Spend occurrence.** Unreachable from the UI (the ledger never pairs a hook, so Partial is never
  offered); reachable by the API. Closed: the API returns 400; the ledger reads a stored one as not given. Traced
  outcome: the old code kept the hook total right but put money on the wrong occurrence; it read HIGH only when the
  partial named a row that is neither a card payment nor allowance spend. One pinned limit: a legacy partial naming an
  allowance purchase reads low, never high (the spending classifier still honours the stored answer).
- **Weekly plan workflow.** The week tile said "Plan not set" and nothing else. Fix: "Forecast assumes $450 a week"
  (from the cash signal's weekly reserve, already fetched) + one owner action "Set weekly plan →" into the existing
  dialog; Spending's prompt carries the same assumption line; Forecast rows read "Assumed $450 · no weekly plan set";
  explicit $0 reads "Plan set to $0"; never "Over" without a plan. After Save, tile, Spending, Allowances, Banking
  household and Forecast flip (verified on the fixture; the app never picks an amount).
- **Chart.** Low-point label placed by a collision rule (above/below, left/right), buffer label at the right end and
  above its line near the bottom, "Today" right of its rule, markers and badges only on payday, big-bill and the
  selected/hovered day, ≤ 5 ticks on a phone. No new library.
- **Journeys.** Two real defects found and fixed: the register highlight expired before the row scrolled into view on
  a phone (highlight now starts when the scroll settles); WebKit replaced the shortfall day with the day under a
  resting pointer (hover now needs 3 px of movement). Labels: Amex tile "Amex purchases · this week"; week tile
  "Counts toward plan"; Spending week "Amex purchases $X · counted $Y · not counted $Z" with a Breakdown link.

## 2. Verification per item
Lead gates on the merged tip 3255981c (fresh test DB, schema pushed first):

| Gate | Result |
|---|---|
| typecheck | pass |
| API vitest, full suite | 293 files passed, 2 skipped · 3,402 tests passed, 0 failed |
| Web vitest, TZ=America/Chicago | 284 files · 2,920 passed, 0 failed, 2 skipped |
| Web vitest, TZ=UTC | 284 files · 2,919 passed, 0 failed, 3 skipped |
| Build + entry graph | landing 622.0 KB of the 622.0 KB budget (621,952 bytes; +0 vs d15dc56e) — met, zero headroom |
| Codegen drift | 0 |
| pnpm audit --prod | 1 high, the known ignored one |
| journeys-e (5 journeys) · chromium + webkit · 1280 + 390 · zero-rows-today | 20 pass / 0 fail (Builder E: 40/40 over both fixtures) |
| journeys2 checks 1, 2, 4, 11, 15 · chromium + webkit · 1280 + 390 | 20 pass / 0 fail |
| axe wcag2a/aa · six routes · 390 + 1280 | one pre-existing serious hit per page (the shell's orange review-count chip); nothing new |
| label probe · five curve shapes · 390 + 1280 | all pass; low/buffer label gap ≥ 5 px; ≤ 5 ticks at 390 |

| Item | Evidence |
|---|---|
| 1 Balance auditable | Σ counted contributions = `sinceAnchor.net` = Checking today − reading (spineParity); pair counts once; anchor-day pending charge counts the tip; `zero-rows-today` and `zero-rows-today-pending` server tests; Details headless 32/32 × 2 modes (chromium + webkit, 390 + 1280) |
| 2 Amounts match | register headline = curve figure for every hook row; day panel outflow = Σ register rows = curve step on `nov-gap`; partial: UI-unreachable test, API 400 test, 5 ledger regression tests; golden unchanged |
| 3 Weekly plan | tile tests (no plan / $0 plan / never Over); Save journey on the fixture flips 5 surfaces; 0 POSTs before the pick |
| 4 Chart | label-probe 10/10 (five curve shapes × 390/1280): no overlap among low, buffer, Today and axis labels; ≤ 5 ticks at 390; `chartLabelPlacement` 7 tests |
| 5 Journeys | `journeys-e` 40/40 (5 journeys × chromium/webkit × 1280/390 × 2 fixtures): h1 + nav + tab + breadcrumb + kept params + Back |

## 3. Preview and screenshots
Fixture kit (git-ignored): `FIXTURE_SEED=rich2 FIXTURE_BALANCE=zero-rows-today bash <scratchpad>/preview/start.sh
/private/tmp/claude-501/cons-int 3420 5220` → http://127.0.0.1:5220 (owner persona). Shots: `<scratchpad>/preview/shots/
t4-final/{before,after}` (Dashboard, Banking, Forecast, Overview, Spending week · 390 + 1280), `shots/d/` (Details,
register), `shots/e/` (chart shapes, tile, Spending).

## 4. Remaining blockers / limits
- Real-data question open: whether the two pending rows post at the same amounts (needs the bank).
- `document.title` is the same on every page (h1, nav and breadcrumb name the place); a per-page title costs landing
  bytes the cap does not have — the landing bundle is exactly at 622.0 KB; any later landing change must trim first.
- Legacy partials on a Spend occurrence still show on their bank row elsewhere (Transactions, Review bucket) — none
  exist in the owner's data as far as the API can tell; the write path is closed.
- "Not counted (n)" in Details includes the rule's 7-day look-back rows, so it is long.

## 5. Identity
Commit on `consistency/integration` (see the handoff message) — local, previewed, NOT pushed, NOT deployed.
