# Final acceptance and repair pass on the live 1b621c5 — consolidated handoff (2026-10-16)

Branch `consistency/integration` (worktree `/private/tmp/claude-501/cons-int`), from 1b621c54 (LIVE). Auditor notes:
`2026-10-16-m-acceptance.md` (money: parts A, B, cross-measure rows) and `2026-10-16-s-acceptance.md` (screens: the
twelve-area matrix, journeys, repairs R1–R7). **Status: built locally, verified on synthetic fixtures and by read-only
live comparison. NOT pushed. NOT deployed.**

## 1. Acceptance matrix (compact)
Columns per area: workflow · navigation · data source · scope kept · totals tie · empty state · error state.
Evidence: headless assertions (chromium + webkit, 1280 + 390, rich2 and zero-rows-today, owner + member) and shots in
`<scratchpad>/preview/shots/s/`, `shots/m/`. "live" = also compared read-only against the owner's signed-in data.

| Area | Result | Evidence |
|---|---|---|
| Dashboard | pass (live) | tile links keep scope; tile figures = spine; 500 → "Couldn't load these numbers" + Try again; live: Checking today, week, month, forecast low agree with Banking/Spending/Forecast |
| Banking review | pass (live) | journeys-e 1; balance = `balance.today`; `?from&to` survives reload; live: today = tile = forecast |
| Chase register | pass | Out / Net / START = ledger totals; `?mode` survives reload |
| Amex, all cards and each card | pass (live) | Owed and Purchases = summary; `?card` `?month` survive; live: purchases = tile; weekly + monthly contributions = purchases |
| Weekly spending | pass (live) | counted / unconfirmed = period breakdown = spine position |
| Monthly allowance | pass (live) | spent = breakdown actual; plan set; live: tile = breakdown |
| Budget + allowances | pass after repair | R6 measure line, R7 credit note; A1: Budget caps now read the plan |
| Forecast overview, detail, reconciliation | pass after repair | R2 titled failure, R3 h1; low point / runway / Checking today = spine = cash signal (live) |
| Debt planning | pass after repair · one label | R1 failed-read state; Amex owed vs debt balance labelled on the Amex page (live gap on the weekly card — owner read needed, below) |
| Reports | 1 cell FAIL (owner call) · error cell repaired | R4; hub "Last 30 days" vs a report's own default week — both labelled, both tie to their source; carrying the range into 5 reports is the fix if wanted |
| Mapping rules + imports | workflow cell BLOCKED · error cell repaired | R5; no import dry-run endpoint exists — only the upload control was checked, nothing uploaded |
| AI categorization + morning recap | workflow cell BLOCKED · rest pass | fixture provider suggests nothing; Change → filed → Undo walked; recap figures = dashboard |

Counts: 84 cells — 75 pass, 6 repaired then pass, 1 fail (owner call), 2 blocked (no fixture path).
Journeys: journeys-e 40/40 · journeys-f 8/8 · journeys2 20/20 · new journeys 6–12 56/56 · mutating 13–14 2/2 ·
per-page matrix 596/596 · scope-kept 32/32 · totals-tie 56/56 · A2 journey 34/34 ×2 browsers.

## 2. Root causes and repairs
- **A1 weekly plan unset while the forecast assumes $450 — not a defect.** Legacy weekly setting is 0; the 2026-05
  backfill writes a plan row only for a non-zero amount; the $450 is the seed's "Weekly Spend" template. Three
  concepts, now each labelled. One reader still mixed them: the Budget month card took its caps from the legacy
  setting — repaired to read the plan in force (fallback to the setting only where no plan row has started).
- **A2 the unconfirmed checking row — one real inconsistency, repaired.** A loan-payment-coded outflow that resembles
  the HELOC bill (prior month matched to the same amount; this month's occurrence skipped). Spending called it
  unconfirmed, Banking called it "Marked unplanned", the forecast saw no bill. Now: Banking reads the same evidence
  class → **Unclear** with "Bank says loan payment"; the suggestion names the skipped bill ("Looks like <bill>, planned
  $P on <day> (skipped)") as a tier-3 pair that never moves the curve; Match = one write that un-skips and matches;
  a new Undo restores every replaced answer exactly. Nothing is classified by the app; Spending's figure is unchanged
  until the owner answers.
- **Screens (R1–R7):** failed reads no longer read as empty or zero on Debts, Payoff plan, Debt report, Spending
  report, Cash flow, Mapping rules; Forecast/To review keep their title on failure and drop the skeleton; Forecast
  overview has an h1; Allowances shows "Counts toward plan · unconfirmed" beside its own weekly measure; Budget drill
  marks a credit "not in the figure".
- **Labels:** Amex "Owed" now sits beside "Payoff plan $X" (typed or synced, said which) with a link to the plan.

## 3. Checks run
Lead gates on the merged tip e67fefaf (fresh test DB, schema pushed first):

| Gate | Result |
|---|---|
| typecheck | pass |
| API vitest, full suite | 296 files passed, 2 skipped · 3,436 tests passed, 0 failed (golden ledger snapshot unchanged) |
| Web vitest, TZ=America/Chicago | 287 files · 2,958 passed, 0 failed, 2 skipped |
| Web vitest, TZ=UTC | 287 files · 2,957 passed, 0 failed, 3 skipped |
| Build + entry graph | landing 622.0 KB of the 622.0 KB budget (+0 vs live) — met, zero headroom |
| Codegen drift | 0 |
| pnpm audit --prod | 1 high, the known ignored one |
| Auditor runs | S: journeys 40/40 · 8/8 · 20/20 · 56/56 · 2/2, per-page matrix 596/596, scope 32/32, ties 56/56 (chromium + webkit, 1280 + 390) · M: A2 journey 34/34 in each browser at both widths, API full 3,436/0, web 2,946/0 on its branch |

Verified against real read-only data (owner signed in): Checking today across tile / Banking / Forecast; week counted and
unconfirmed across tile / Spending / Banking; month allowance across tile / Spending; forecast low across tile / detail;
Amex purchases = tile and = weekly + monthly contributions; the unconfirmed row's evidence, bucket and the HELOC history;
the weekly card's debt balance source (typed) vs its owed source (Plaid). Verified with fixtures: everything in the
matrix and the journeys. Not verified: a real workbook import (no dry-run exists); a live AI suggestion (fixture provider
only); the two pending rows posting (bank only).
Real-value rescan of the Task 6 diff: 0 hits. **Pre-existing public value (not from this pass):**
`artifacts/api-server/src/__tests__/cashSignalOverdueEvidence.integration.test.ts` carries a real lender name and
payment amount from an earlier pass; it is tolerance-sensitive, so it is reported here for a deliberate scrub rather
than changed at the end of this pass.

## 4. Owner decisions and missing evidence (one list)
1. **Weekly plan.** Set one (Set weekly plan → the chooser) or keep the forecast's $450 assumption. Consequence: until
   set, the week tile cannot say over/within and the forecast reserves the template.
2. **The unconfirmed loan-payment row.** Match it to the skipped HELOC occurrence (Banking › Unclear › Match; Undo
   exists) or file it as something else. Consequence: it stays "unconfirmed" in Spending and "Unclear" in Banking.
3. **Weekly card: debt balance vs card owed — settled by a live read-only check.** That debt row's balance is typed
   (`balanceSource: manual`, never synced since), while the card's owed figure comes from Plaid. Two measures by
   definition, now labelled on the Amex page ("Payoff plan $X · typed, not from the card"). Consequence: the Debt tile,
   "% paid", Avalanche and milestones use the typed figure until the debt is re-linked or its balance edited.
4. **"Not mine" rows** still count in the household weekly plan (classification call, unchanged).
5. **Bank evidence:** whether the two pending rows post at the same amounts (bank only). Details says "Estimate".
6. **Reports hub window** (30 days) vs a report's default week: carry the range into the reports, or leave both labelled.
7. **Per-page browser-tab title** and the **Debt tile label**: blocked by the landing budget (0 bytes of headroom).

## 5. Identity
Commit on `consistency/integration` (see the handoff message) — local, previewed on the fixture kit, NOT pushed, NOT deployed.
