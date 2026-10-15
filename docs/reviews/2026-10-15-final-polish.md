# Final polish round (from prem/integration 1561ed1b)

Synthetic fixtures only. No live amounts in this note. One section per builder.

## Builder S — branch prem/final-s (server, core, spec)

### #7 · a fix on a card row could not be previewed
- Was: the dry run asked the Banking review for every row's account. A card row (an Amex pay-later instalment the loan_payment proposal lists) → `account_not_ledger` → 400 HTML page → the Fix dialog never enabled Apply. The apply itself worked.
- Now: Banking figures only for accounts the Banking review accepts (`bankingScopesOf` → `resolveLedgerAccounts`, the review's own rule: checking, savings, the forecast's account and its twins). A card row gets no Banking entry; its own before → after is in `rows`; week, month and Budget figures carry it.
- Card rows stay in loan_payment (the owner's rows are mostly card rows). The `reviewProposals.ts` header's "(not a card)" now says "not a card PAYMENT".
- No new limitation value (the spec enum and the web words are unchanged); `figures.banking` says it in its description.
- Test: Affirm bill + AFFIRM INC −25.00 on Amex Blue: dry run 200, `figures.banking` = [], apply = preview (week, month, Budget, ledger pairing), undo exact. A checking fix still previews its Banking figures.

### #8 · undo of a mark-matched-only fix wiped a later answer
- Was: the apply stored every listed row's open queue items as "reopened by undo", but closed only the FILED rows'. Owner skips the question after the fix → undo wiped resolvedAt / resolution / resolvedBy → the question came back.
- Now: the record keeps only the filed rows' open items (exactly the set `recordUserDecisions` closes).
- Also: the undo reopens an item only while it is still closed as the apply closed it ("corrected", via user, by the actor).
- Test: bill_match fix (files nothing) → `reopenedDecisionIds` [] → owner Skip → undo → still "skipped" by the owner. The income_category test (a filed row's item reopens on undo) still passes.

### #9 · Bills and the forecast chose different posted rows — already fixed by round 6
- The reviewer's probe on 1561ed1b (and on this branch): Bills Oct Gasco 0.00, Water 0.00; Bills Sept Water 0.00; ledger Gas 10/02 "suggested" (the posted row offered, not paid), Water 9/28 overdue. They agree.
- Why: `loadAnswerTwins` builds one household-wide map from every answered expired hold; each reader looks its rows up there, so the twin no longer depends on which answers a caller passes.
- No code change. Test added: the reviewer's case (two answers in two months, one ONLINE BANKING PMT −60): no twin, the ledger pays neither with it, Bills Sept / Oct 0.00, and one reader's subset reads the same map as both rows.

### #10 · "usual" needs real history (owner-visible)
- Rule: a category shows a usual only with rows in at least HALF of the window's periods, never fewer than 2 (`usualHistoryNeeded`: 8 weeks → 4, 3 months → 2, a 3-week window → 2). Else usual / usualFullPeriod / aboveUsual null + historyPeriods → the web's existing "Not enough history".
- One helper (`hasUsualHistory`, avalanche-core `waysBack.ts`) for the period breakdown and the ways back.
- Figures that move: only which categories show a usual. Amounts, known, unresolved, actual unchanged.
  - Reviewer's rich2 case: Groceries 2 of 8 weeks, "usual by Wed $0.00 · above usual $207.60" → "Not enough history".
  - Unit fixture (ways back): Groceries 2 of 8, usual 0 → null. Dining 6 of 8 unchanged (75.00).
  - Unit fixture (breakdown): Gas 2 of 8, usual 0.00 / above 30.00 → null.
  - expiredHoldsPremium, kill switch (base) side: Dining 2 of 8, usual 0.00 → null. Rule-on side unchanged.
  - Exactly half is enough: periodBreakdownUsual's Dining (4 of 8) keeps 5.00.
- Tests: core (2, 3 of 8 → null; 4 of 8 → 10.00; 5 of 8 → 25.00; short window 2 of 3 → shown); API (Coffee 2 of 8 → null in both endpoints; Fuel 5 of 8 → 25.00 / above 20.00 in both; breakdown usual = ways-back usualWeek).
- Spec: descriptions only (usual, usualFullPeriod, aboveUsual, historyPeriods, usualWeek, usualFullWeek). Codegen regenerated.
- Web untouched: its "Not enough history" reads `usual == null`. Its comments still say "2+ prior periods" (Breakdown.tsx, WaysBackSheet.tsx; left for the web owner).

### #13 · balance check compared anchor strings
- Now `sameAnchorMoment`: Date.parse both; NaN on either → compare as written; no anchor now → changed.
- Moves: "2026-10-14T07:00:00-05:00" vs "2026-10-14T12:00:00.000Z" → stale false (was `anchor_changed`): "Matches bank", not "Checked 1 d ago". In production both are toISOString, so nothing moves there.
- Test: offset vs Z both ways, a different moment still changed, null, unparseable.

### Lead addition 1 · a posted row that pays the hold's OWN bill is no twin
- Was (round 5 and 6): `evidenceElsewhere` skipped the hold's own plan, so the next payment of the same bill could be taken as the failed payment's twin.
- Now: the hold's own BILL (the one its answer names) is checked like any other plan — its name, its category, a row confirmed for it. Such a row is left to the evidence path, which pays the week it belongs to.
- Kept: a debt the hold is tagged to (and a bill linked to it) stays skipped — the debt plan reads tags, not names; round 5's "VISA CARD ONLINE PMT" twin for a tagged Visa payment still counts.
- Kept: round 5's CPWR pin (a payee name that differs from the bill) is still the one sure twin; a weekly variant added.
- Figures (verifier's probe zzVf6r6B; weekly 150, failed answered payment, next payment posted):

| Case | base | r4 | r6 | now |
|---|---|---|---|---|
| W1 fresh: lowest / Bills Sept | 1,070 / 150 | 1,070 / 0 | 920 / 150 | 1,070 / 0 |
| W1 old: lowest / Bills Sept | 920 / 150 | 920 / 0 | 770 / 150 | 920 / 0 |
| W2 fresh: lowest / Bills Oct | 1,220 / 150 | 1,070 / 0 | 1,070 / 150 | 1,070 / 0 |
| W2 old: lowest / Bills Oct | 920 / 150 | 920 / 0 | 920 / 150 | 920 / 0 |

- "now" = the control with no answer in every case, and = the verifier's tested fix (r6fix) to the cent. r6's extra drag was −150 on Fri 10/16.
- W2's base 1,220 differs from every later round with or without the answer (the expired-holds rule itself); not this change.
- Probe A (verifier's W / U / A cases) on this branch = r6 exactly.
- Test: pinned in `expiredHoldAnswers.integration.test.ts` (W1, W2 × fresh, old: answered = control, the figures above, no twin). With the change switched off: 4 fail.

### Lead addition 2 · the forward-clean-cut guard is in the suite
- The verifier's randomized "list labels vs whole ledger" test, renamed and added to `supersededPendingWindow.integration.test.ts` (fixed seed 4242, 400 rows, 72 ranges; the env knobs dropped).
- Checked: with `forwardCleanCut` switched off (pairTo = to) it fails, and it is the only failure across `supersededPendingWindow`, `supersededPending` and `expiredHoldsRound5` (16 others pass). With the cut on, it passes.

### Files
- `artifacts/api-server/src/lib/reviewCorrections.ts` (#7, #8)
- `artifacts/api-server/src/lib/reviewProposals.ts` (header words)
- `artifacts/api-server/src/lib/supersededPending.ts` (lead addition 1)
- `lib/avalanche-core/src/waysBack.ts`, `periodBreakdown.ts`, `index.ts` (#10)
- `lib/avalanche-core/src/bankCheck.ts` (#13)
- `lib/api-spec/openapi.yaml` + generated `lib/api-zod`, `lib/api-client-react` (descriptions only)
- Tests: `reviewCorrections`, `expiredHoldAnswers`, `supersededPendingWindow`, `periodBreakdownUsual`, `expiredHoldsPremium` (integration); `periodBreakdown.test`, `waysBack.test`, `bankCheck.test` (unit)

### Gates
- `pnpm run typecheck`: pass.
- Full API suite: 289 files passed, 1 skipped; 3,357 tests passed, 1 skipped, 7 todo (spineParity included).
- Web vitest: Chicago 260 files, 2,605 passed, 2 skipped; UTC 260 files, 2,604 passed, 3 skipped.
- `pnpm run build` + `check-entry-graph`: pass, landing 616.7 KB of 622 KB (no web file changed).
- Codegen drift: a second codegen run leaves the tree clean. (The first run also rewrote `lib/db/dist/schema/index.d.ts` with keys reordered by tsc; reverted, not committed.)

### Doubts
- #7: the card's Banking figures are absent, not "not previewed": no limitation value is sent. If the web should say so, it needs a word for it.
- #10: the rule uses the window after tracking began; a household 3 weeks in needs 2 of 3 weeks, not 4.
- Lead addition 1: only the hold's own bill is checked; a debt-linked bill reached through a debt tag is still skipped (the debt plan's twin needs it).

## Builder W (web) — branch prem/final-w

### What changed
- #1 Chase Back: `useUrlState` gets `popFallback`. A popstate onto an address with no `?account=` means "no pick" (the default account), not the saved pick. Chase passes `() => accountKey ?? null`. First mount still reads the saved pick.
- #2 Chase balance chart: the balances answer goes through `scoped()` (a placeholder is not this account's). `balanceTrend` is null while the register is a placeholder. No previous-account points, no previous-account "today".
- #3 Review month picker: `monthWindowPending` (placeholder answer whose `fromDate` is after the picked month's 1st). Shows "Loading <month>…" (role=status, aria-busy), hides the empty state and the From Chase card with its 0 counts.
- #4 One tone rule for Over: `weekStatus(...).tone === "bad"` in the dashboard Room line (`SummaryRow`) and the spending meter (`SpendingPanel`, via `withinOfRemaining(remainingWeekKnown)`, same as `PeriodView`). `!provisional` dropped.
- #5 WeekPlanPanel source word is tri-state: unknown owner reads empty, never "set by you".
- #6 Banking note: "Card and debt payments and transfers are not spending."
- #11 /debts table wrapper: `tabIndex=0`, `role="region"`, `aria-label="Debts table"`.
- #12 Forecast section tab for /review is "To review" (breadcrumb follows). Banking › Review keeps "Review".
- #14 Banking household Plan value: "Not set" (was "Plan not set").

### Files
- artifacts/h2budget/src/hooks/useUrlState.ts
- artifacts/h2budget/src/pages/transactions.tsx
- artifacts/h2budget/src/pages/forecast.tsx
- artifacts/h2budget/src/pages/next/dashboard/SummaryRow.tsx, SpendingPanel.tsx
- artifacts/h2budget/src/components/plan/WeekPlanPanel.tsx
- artifacts/h2budget/src/pages/command-center.tsx, debts.tsx
- artifacts/h2budget/src/lib/navModel.ts

### Figures that move
- None. Words and tones only.
- Dashboard Room line and spending meter: known over while the week is not final now read rust (was neutral).

### Tests
- chaseScope: first pick with no `?account=`, Back returns to the default (fails before the fix); balance chart absent while B loads (fails before the fix). Fake ledger server gets `holdBalances`.
- forecastHorizonSwitchPerf: older month while the previous window is held shows Loading, no empty state, no card.
- dashboard: Room line and meter rust when known over and provisional.
- planPanels: unknown owner, source word empty.
- debtsPageRowStability: region, tabindex, label.
- Updated to the new words: appShell, routes, bankingReview tests.

### Doubts
- #12 is a naming call: "To review" matches the "N to review" chip. Owner may prefer another name.
- #2 hides the chart while the register is a placeholder, including a same-account range change (brief flash of no chart).
- axe at 390 on /debts, /banking, /review, /transactions: no scrollable-region-focusable. Remaining `meta-viewport` and `region` hits are on every page (app shell), not touched here.
