# F6 ⇄ premium merge — expired holds on the premium line (branch prem/f6-merge)

From prem/integration 3b4fe073; merged fix/f6-opencap 3c44d924 (F6 rounds 1–5; rounds 1–4 live as 70c7ebcb).
Synthetic fixtures only. Nothing pushed, merged into prem/integration or deployed.

## The rule (owner, 2026-10-15)
- A row still pending more than 7 days after its date counts nowhere.
- Its reversal credit (up to 31 days later) goes with it.
- Read time only; nothing deleted; the row stays visible with its label.
- Kill switch `EXPIRED_HOLDS_RULE=off` = the behaviour before the rule.

## Commits
- `625a5600` the merge (conflicts below).
- `53e4c485` "N pending" counts no expired hold (a held pair stays in the money, out of the count).
- `d289e1b8` tests: every premium reader (API 12, web 3).
- this note.

## Conflicts and how each was resolved (both intents kept)
| File | Premium side | F6 side | Resolution |
|---|---|---|---|
| `openapi.yaml` BankingReviewCashFlow | Q1 `pendingCount` (required) | description names expired holds | both: F6 words + `pendingCount` |
| `amexAnchor.ts` readCardPeriods | Q1/Q2 overlay `patchRows` | `notCountedIdsOf` | both imports; overlay on rows, notCounted on ids |
| `amexAnchorRead.ts` computed anchor | Q3: per source, owed sign (`normalizeCardAmount`) | sum less expired holds (raw sign) | Q3 sum − expired holds, each on the owed sign by its own source |
| `moneyContext.ts` loadMovementRows | Q2 overlay `patchRows` | `countsNowhere` | both |
| `amexEndingBalance.ts`, `amexBalanceWindow.ts` | Q3 `cardOwedMoves` (owed sign, posted only) | `isCounted` filters | Q3's code; the skip moves into `cardBalanceWalk.movesCardBalance` = posted AND `isCounted` (one rule: tile, chart, per-row walk) |
| `amex.tsx` | Q6a removed `monthTotals`, `endingBalanceMeta`; `dayInOut`; Q3 walk; Q6b Pending chip | skips in `monthTotals`, day total, walk; `ExpiredHoldLabel` on the phone row | dead code stays removed; `dayInOut` skips an expired hold; Q3 walk; label kept; an expired hold shows its label, not "Pending" too |
| `Accounts.tsx`, `ActivityPanel.tsx` | Q4 `categoryCell` | `expiredHold` status | both |
| `amexAnchorRoute` test | Q3 computed cases | F6 computed case (raw sum: 70 / 18) | both; F6's case re-derived on the owed sign: 90 / 142 |
| `amexEndingBalance.test`, `amexBalanceWindow.test` | Q3 Plaid cases | F6 cases (workbook-shaped rows) | both; F6 cases rewritten as Plaid rows (bank sign, `pending` + `expiredHold`), same figures (1,020 / 990; chart 1,000 / 1,020) |
| generated client (4 `.d.ts.map`) | — | — | ours, then `rm -rf` dist, codegen; `lib/db/dist` reverted (tsc order noise) |
- `runningBalance.RowLike.expiredHold` widened to `boolean | null` (the card walk's rows carry the server's nullable flag).
- openapi.yaml: 160 paths, 401 schemas, no duplicate. Migrations: F6 adds none; premium's 0210 / 0220 / 0221 unchanged.

## Every premium reader (✔ = honours expired holds through the one read)
| Reader | How | Test |
|---|---|---|
| Q1 position + spine `knownWeek` / `unresolvedWeek` / `remainingWeekKnown` / `provisional` | `loadPositionInputs` → `loadAllowanceWindow` → `loadMovementRows` (`countsNowhere`) | expiredHoldsPremium (week contract) ✔ |
| Q1 breakdown known / unresolved (this week, past weeks, month) | same read | expiredHoldsPremium (breakdown ×2) ✔ |
| Q1 `historyPeriods` / `usual` | history window through `loadAllowanceWindow` | expiredHoldsPremium (Dining 2 → 1 weeks, usual 0.00 → null) ✔ |
| Q1 ways back `usualWeek` / `historyPeriods` | `loadMovementRows` | expiredHoldsPremium (ways back) ✔ |
| Q1 Banking buckets `moneyIn` / `moneyOut` | placed rows = counted less `expiredIds` / `expiredPair` | expiredHoldsPremium (Banking) ✔ |
| Q1 `reviewInbox.unresolvedInRange` | same `counted` set | expiredHoldsPremium (7 → 4) ✔ |
| Q1 planned `outcome` | ledger fates; an answer on an expired hold names no row (`readAnsweredRows`) | expiredHoldsPremium (City Water paid → not paid yet) ✔ |
| Q1 `bankConfidence.pendingCount` + `cashFlow.pendingCount` | `readLedgerTotals`: register `expired` (0) + `expiredPair` left out (commit 53e4c485) | expiredHoldsPremium (6 → 2; held pair 8 → 2) ✔ |
| Q2 proposals | `loadMovementRows` | expiredHoldsPremium (PEAR 10/03 never listed) ✔ |
| Q2 apply with a stale proposal naming a hold | recomputed proposal, hash/rows differ → 409 | expiredHoldsPremium (409 `proposal_changed`, nothing written) ✔ |
| Q2 dry-run overlay = applied; undo | overlay patches category / transfer flags only (see Decisions) | expiredHoldsPremium (before / after = CONTROL; applied = dry run; undo) ✔ |
| Q3 web card walk (`cardBalanceWalk`, `amexEndingBalance`, `accountBalance`, `amexBalanceWindow`) | `movesCardBalance` = posted AND `isCounted` | cardBalanceWalk (+2, seeded forward = backward), amexEndingBalance (F6 case), amexBalanceWindow (F6 case) ✔ |
| Q3 server `computed` anchor | owed-sign sum less expired holds (owed sign) | amexAnchorRoute (90; kill switch 142) ✔ |
| Q5 week tile, header, Needs attention, Room line | spine `knownWeek` (server) | expiredHoldsPremium (spine) ✔ |
| Q5 Banking page buckets, household block | GET /banking/review | expiredHoldsPremium (Banking) ✔ |
| Q5 Proposed fixes | GET /review/proposals + dry run | expiredHoldsPremium (Q2) ✔ |
| Q5 Afford `remainingWeekKnown` | position | expiredHoldsPremium (afford) ✔ |
| Q6 Amex summary purchases, credits, Needs attention ("N to review"), household known / unconfirmed | `notCountedIdsOf` + `loadAllowanceWindow` | expiredHoldsPremium (month + this week) ✔ |
| Q6a Amex day out / in | `dayInOut` skips `!isCounted` | amexCalmRows (+1) ✔ |
| Q6a/Q6b Amex row chips | label "Expired hold · not counted"; no "Pending" beside it | amexCalmRows (+1) ✔ |
| hh-split parity (summary = breakdown per card) | unchanged | amexSummary.integration (green) ✔ |
- The proof is two households seeded alike, one also holding six expired holds (two reversals, one answered for a bill): with the rule, every figure above equals the control's; with the kill switch, each differs (stated in the test).
- Kill switch = the premium tip: the same fixture run on a detached 3b4fe073 worktree (no rule) gives exactly the merge's kill-switch figures — 13 of 13 reads equal (position, spine, 4 breakdowns, Banking, Amex month + week, Afford, proposals, ways back, the list).

## Decisions
- `pendingCount`: an expired hold is not "pending" (recommended). An unheld one was already out (register `expired`). A hold the snapshot held and its reversal (`expiredPair`) count in the balance (net 0, money back) but are now left out of the count; `pendingNet` keeps them (money).
- Dry run = applied, with holds present: the overlay writes only category / transfer / allowance flags. A hold's pairing reads `isTransfer` (`canBeReversal`), but a proposal never lists a hold or its reversal, and making an unpaired pending credit a transfer only removes it from candidacy — no pair changes. The test applies a transfer fix beside two holds and checks applied = dry run.
- Amex rows: an expired hold carries one label ("Expired hold · not counted"), not "Pending" beside it (as Accounts / Activity already do).

## Figures that move (premium tip 3b4fe073 → this branch; synthetic)
- Every F6 figure (rounds 3–5, `2026-10-15-f6-opencap.md`) now holds on the premium line.
- New, on the premium readers (expiredHoldsPremium, HOLDS household):
  - Position / spine: known week 42.00 → 82.00; spent 62.00 → 102.00; left on known 258.00 → 218.00; left 238.00 → 198.00.
  - spine.bankConfidence.pendingCount 6 → 2 (with a held pair: 8 → 2).
  - This week's breakdown: 62.00 → 102.00 (known 42.00 → 82.00); Dining −10.00 → 70.00, history 2 → 1 weeks, usual 0.00 → null.
  - Week of 10/04: 169.18 → 25.00. Week of 9/27: 90.00 (20.00 unconfirmed) → 40.00. Month (monthly plan): 45.00 → 0.00.
  - Ways back: hold per day 79.33 → 66.00; trims [Subscriptions] → [Dining, Subscriptions].
  - Banking Oct 1–15: Not on the plan 7 · in 1,564.18 · out 146.18 → 4 · 1,500.00 · 62.00; City Water paid → not paid yet; to review 7 → 4; pendingNet −152.00 → −32.00; balance today 3,318.00 → 3,438.00.
  - Amex month: purchases 220.00 (5) → 65.00 (2); credits 80.00 → 0.00; unfiled 2 · 55.00 → 1 · 25.00; household weekly 95.00 → 65.00, monthly 45.00 → 0.00.
  - Amex this week: credits 80.00 → 0.00; household weekly 0.00 → 40.00.
  - Afford, week left on known: 258.00 → 218.00.
  - Proposals: transfer rows [PEAR 10/03, PEAR 10/13] → [PEAR 10/13].
- Merge-only moves:
  - Amex `computed` anchor: 142.00 → 90.00 (the F6 line read 18.00 → 70.00 on the raw sum).
  - Amex day line with a 150.00 expired hold: "-$221.00 out · +$10.00 in" → "-$71.00 out · +$10.00 in".
- Forecast golden, spine parity, hh-split parity: unchanged (green, golden not regenerated).

## Tests added / changed
- API `expiredHoldsPremium.integration` (new, 12).
- API `amexAnchorRoute`: F6 case re-derived on the owed sign (90 / 142).
- Web `cardBalanceWalk.test` (+2), `amexCalmRows.test` (+1), `amexEndingBalance.test` / `amexBalanceWindow.test` (F6 cases on Plaid rows).

## Gates
- `pnpm run typecheck`: pass.
- Full API suite (own DB `h2budget_test_f6merge`, run alone, ~12:45 CT): 289 files passed, 1 skipped · 3,325 tests passed, 1 skipped, 7 todo. 0 failed.
  - On the bare merge commit (before the follow-ups): 288 files · 3,313 passed (premium 3,217 + F6's ~96).
  - Named re-run: spineParity, forecastLedger.golden, amexSummary (hh-split parity), amexCheckingScenario, expiredHolds / Round5 / Answers / Premium, reviewCorrections, bankingReview, openWeekCap: 11 files, 159 passed. Golden not regenerated (file untouched).
  - `plaidAccountTwinsOnSync` passed (run before 19:00 CT).
- Web vitest: `TZ=America/Chicago` 259 files, 2,597 passed, 2 skipped · `TZ=UTC` 259 files, 2,596 passed, 3 skipped. 0 failed.
- `pnpm run build` + `node scripts/check-entry-graph.mjs`: OK, landing 617.0 KB of 622 KB (premium tip 616.8 KB; F6's two tiny preload entries).
- Codegen drift: a second codegen run leaves the tree clean; only description changes in this branch's generated files.
- Kill-switch probe (not committed): the premium fixture on a detached 3b4fe073 worktree (own DB, dropped) = this branch with `EXPIRED_HOLDS_RULE=off`, 13 of 13 reads.

## Doubts / not done
- `pendingCount` for a held pair is a choice (documented above); say if "N pending" should list them.
- Q3's own doubt stands: the `computed` anchor still counts YOUNG pending rows while the walk skips every pending row (now less expired holds on both sides).
- Chase still lists an expired hold inside its pinned "Pending" group (grouping, as on the F6 line); the row says "Expired hold · not counted".
- F6's open doubts carry over unchanged (see `2026-10-15-f6-opencap.md`, rounds 3–5).
- Later fixes on fix/f6-opencap or prem/q5-fix3 need another merge; not touched here.
