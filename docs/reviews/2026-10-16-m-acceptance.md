# Task 6 · Auditor M (money) — acceptance and repair on 1b621c5 (2026-10-16)

Branch `cons/m-money` from `consistency/integration` 2a23019e (= live 1b621c54). Local commit only. Not pushed, not deployed.
Synthetic fixtures only. The owner's live figures stay in the private scratch file. None are in this note, the tests or the kit mode.

## 1. Summary
- A1: the weekly plan was never set. That is the owner's decision. One reader still mixed the concepts: the Budget page's Allowance card took its caps from the legacy setting. Repaired, and no live figure moves.
- A2: an `unresolved` row (the bank says loan payment, transfer or income) now sits in Banking › Unclear with the bank's words, never in Unplanned activity or Marked unplanned.
- A2: a skipped occurrence can now be a suggestion (tier 3, never off the curve). The row's evidence names it ("Looks like …, planned $P on <day> (skipped)").
- A2: Match is one write; Undo puts back exactly what it replaced, so the skip returns.
- Matrix: six rows, plus the coordinator's Amex owed ⇄ debt-plan row. Two new fake-household render tests. The Amex owed is now labelled beside the payoff plan's own figure.
- B: the trace table holds. All 28 named tests are present, and they pass in the gates below. Missing evidence (bank only): whether the pending rows post at the same amounts.

## 2. A1 — weekly plan, forecast assumption, legacy setting

| Concept | Where stored | Every reader | What the screen says |
|---|---|---|---|
| Forecast reserve template | the "Weekly Spend" recurring item's `amount` (seed `S/lib/budgetSeed.ts`), an everyday hook | the ledger's hook reserve while no plan is set (`S/lib/everydayHooks.ts`); `planPrefills` source `hook_stored` (`S/lib/allowancePlans.ts:157-199`) | "Forecast assumes $X a week"; Forecast rows "Assumed $X · no weekly plan set"; the item's own amount behind Details as "a template" |
| Plan | `allowance_plans` (one writer: `S/lib/allowancePlanWriter.ts`) | `everydayPlanFromRows` / `allowancePlanInEffect` (`C/householdMoney.ts`) in money position, period breakdown (Spending week + month, the spine's `monthAllowance`), everyday hooks, Banking household; **and now the Budget Allowance card** | "Plan not set" ≠ "Plan set to $0"; "Set a weekly plan →" |
| Legacy setting | `settings.weekly_ / monthly_ / unplanned_allowance_amount` | `planPrefills` (source `settings`, "Saved allowance"); the Settings › Allowances panel (its own editor; a save is mirrored into the plan, `mirrorSettingsAllowance`); `GET /dashboard-budgets` fallback (Settings page only); `moneyContext.settings` (loaded, read by no figure); `everydayPlan` (tests only); **before this pass, the Budget month's allowance caps** | prefill "Saved allowance"; Settings fields |

- Verdict: the owner never set a weekly plan. The forecast's figure is the template, offered as a prefill. **Owner decision, not a repair.**
- Mixed reader found: `S/routes/budget.ts` (the month view, `buildAllowanceRollup`) read the caps from the setting, and its Help said "The caps come from Settings". The plan dialog writes only `allowance_plans`, so a weekly plan set there never reached that card.
- Repair: the weekly and monthly caps are the plan in force for the month. That is the week holding today (current month), the month's last week (past months) or its first week (later months). A $0 plan row is that plan.
- Where no plan row has started yet, the card keeps the setting (the history before plans existed). Unplanned stays on its setting, since there is no plan for it. The Help sentence now says so.
- Figures that move: none on live. The monthly plan row equals the setting from its start; before it, the fallback is the setting; the weekly setting is 0 with no plan. They move only where the setting and the plans differ.
- Fixture probe (settings 100/250, May): before, a weekly plan of 320 and a $0 monthly plan changed nothing (weekly 442.86, monthly 250.00). After: weekly 1,417.14, monthly 0.00.

## 3. A2 — the unconfirmed loan-payment row and the skipped bill
Fixture shape (synthetic): monthly "Credit Line (Northwind)" $820.00 on the 2nd. The prior month was matched to "NWD LNS PMT" −861.37, the current month skipped, two earlier months missed. This month's row "NWD LNS PMT" −861.37 (Plaid LOAN_PAYMENTS / LOAN_PAYMENTS_OTHER_PAYMENT) has no category and is marked "not a planned payment".

### What changed
- `C/bankReview.ts`: rule 2u. With evidence class `unresolved`, a row lands in `uncertain`, reason `evidence_unresolved`. It applies where the row would otherwise be `confirmedUnplanned` (rule 2) or `unmatched` (rule 7). Rules 1, 3, 4, 5 and 6 keep their place. `UNCERTAIN_REASONS` gains `evidence_unresolved`.
- `S/lib/bankingReview.ts`: computes `rowEvidenceOf` (the same evidence context Spending uses) before placing the row, passes the class, and returns `rowEvidence` on every row (`evidenceView`, moved to `S/lib/rowEvidence.ts`, one serializer).
- `C/planMatch.ts` `suggestSkippedPlans`: the matcher's own rules on skipped occurrences, and every pair forced to tier 3, no evidence, `offCurve` false.
- `S/lib/forecastLedger.ts`: skipped occurrences in the match window become candidates. The rows offered are those no pair, card rule or decision holds; a row claimed only by "not a planned payment" is still offered.
- The ledger exposes `ledger.skippedSuggestions` (internal). Fates, the curve and `matches` never read it.
- `S/lib/rowEvidence.ts` `billSuggestionsOf`: adds those pairs marked `skipped`, and the planned amount on every target.
- `C/evidenceRule.ts`: a skipped target never becomes the `bill_suggestion` reason. The row keeps its own reason and its suggestion gains the target (`planned`, `skipped`). The class never moves.
- `S/routes/forecast.ts`: `POST /forecast/resolutions` runs its same statements in one transaction and returns `replaced`. New `POST /forecast/resolutions/:id/undo` (features tag) restores exactly. It accepts only answers that write could have deleted (`isNeighbourOf`), with the same ids and fields (`undoForecastResolution` in `S/lib/forecastResolutionWrite.ts`).
- `W/pages/banking/words.ts` and `BucketRows.tsx`: chip "Unconfirmed" (Spending's word), line "Bank says loan payment", line "Looks like <plan>, planned $P on <day> (skipped)", and Match / Not this (owner only), each with an Undo toast.

### Fixture before → after (API probe, same fixture on 2a23019e and on this branch)
| | Before (2a23019e) | After |
|---|---|---|
| Banking bucket · reason | Marked unplanned · `ignored_unforecasted` | Unclear · `evidence_unresolved` |
| Row words | none (no evidence on the row) | "Bank says loan payment" |
| Suggestion | none; Spending's target null | "Looks like Credit Line (Northwind), planned $820.00 on May 2 (skipped)"; target on Spending too |
| Ledger | May `skipped`; no suggestion | May `skipped`; one tier-3 pair (diff 41.37, 10 days), `offCurve` false; `matches` names nothing |
| Spending Unconfirmed | 861.37 (1 row) | 861.37 (1 row): unchanged |
| Match | one write (no `replaced`) | one write; `replaced` = the skip and the "not planned" answer |
| After Match | Amount differences · forecast May `matched` · Spending 0.00 | the same |
| Undo | DELETE: the skip and the answer are gone; May reads `paid_on_evidence` with no answer | all five answers back, same ids and times; May `skipped`; row Unclear again |

- rich2 + `FIXTURE_UNCONFIRMED=skipped-loan`, Banking Oct 1–14: Marked unplanned 2 rows / $946.37 → 1 / $85.00.
- Same range: Unclear 2 / $144.00 → 5 / $2,210.56 (three unresolved: the NWD row, a pending loan payment, a pending savings transfer). Unplanned activity 5 / $1,365.19 → 3 / $160.00.
- Unchanged: As planned, the reconciliation, Spending's week and the position.
- Headless (`<scratchpad>/preview/m-journey.mjs`): Banking → Unclear → the row's words → Match → forecast matched → Undo → skipped. Chromium and WebKit at 390 and 1280, 34/34 each, two fresh rounds. Shots in `<scratchpad>/preview/shots/m/`.

## 4. Cross-measure matrix (like with like) — the fixture column filled, the live column for the lead
| Pair | Side A · source | Side B · source | Verdict | Reconciles via | Fixture | Live (lead) |
|---|---|---|---|---|---|---|
| Checking today: tile ⇄ Banking ⇄ Forecast KPI/card ⇄ Overview | `spine.bank.balance` | `/banking/review balance.today`, `cashSignal.bankToday` (all `computeCashSignal().bankToday`) | equal by design | Details ("Why this number?") | `balanceConsistency.test.tsx` C1/H1–H5 · `spineParity` | |
| Week counted / unconfirmed: tile ⇄ Banking household ⇄ Spending week | `/money/position` `knownWeek`/`unresolvedWeek` (`buildMoneyPosition`) | Banking `household` = the same position; Spending `/money/period-breakdown` `known`/`unresolved` (same evidence rule) | equal by design | Spending week → Unconfirmed → Banking proposed fixes | **new** `moneyMatrix.test.tsx` (tile = Banking); `expiredHoldsPremium` (Banking = position; breakdown = position values) | |
| Unconfirmed row: Spending ⇄ Banking | `periodBreakdown` evidence class `unresolved` | Banking rule 2u (same `rowEvidenceOf`) | equal by design (**repaired here**) | Banking › Unclear row → Match | **new** `skippedOccurrenceSuggestion.integration` | |
| Month allowance: tile ⇄ Spending month | `spine.monthAllowance` = `readMonthAllowance` | Spending month `planViewOf` (`periodBreakdown.ts`) | equal by design | — | `periodBreakdown` suites | |
| Month cap: Spending month ⇄ Budget Allowance card | `allowancePlanInEffect` | Budget `buildAllowanceRollup` caps, now the plan in force (**repaired here**) | equal by design (cap); spent is a different reader (Budget month aggregate vs period breakdown), not proven equal here | Budget card "Manage" → Allowances | **new** `budgetPlanBySource` case | |
| Amex purchases (gross) ⇄ plan contribution | Amex `purchases` (`classifyCardCredit`) | Spending week "counted" (`reconcileAmexPurchases` groups) | different by definition | Spending week "Amex purchases $X · counted $Y · not counted $Z" → Breakdown → Amex reconciliation (Task 5) | `AmexWeekLine.test` · `amexSummary` reconciliation | |
| Amex owed ⇄ debt-plan balance | Amex `owed.current` = `resolveAmexAnchor` (the card's Plaid liability, #651) | Debt tile / Avalanche / Accounts "Owed" = `debts.balance` net of pending (`effectiveDebtBalance`) | equal when the debt is synced; different by definition when typed (see §5) | **new** Amex "Owed" line "Payoff plan $X · typed, not from the card · Payoff plan" | **new** `amexSummary` typed case, `amexSummaryPanel.test` | |
| Debt tile ⇄ Avalanche ⇄ Reports | `remainingDebtScope` | Avalanche Totals (same helper) | equal by design | — | `debtBalanceParity.test.tsx` | |
| Forecast low / end: tile ⇄ detail ⇄ Overview (90 days) | `spine.forecast.lowPoint` | detail KPI, Overview stat (`lowPointView`) | equal by design at 90 | tile → `/forecast?horizon=90&day=<low day>` | **new** `moneyMatrix.test.tsx` (tile = detail = Overview); `balanceConsistency` C3 | |

## 5. Coordinator's row — Amex owed vs the debt plan's balance (trace)
- Sync writes a debt's balance only when `balanceSource = plaid`: `applyCachedLiabilitiesToPlaidDebts` → `applyLiabilityToDebt` (`S/lib/debtLiabilityApply.ts`), copying `plaid_accounts.liability_balance`. Nothing excludes an in-full card; the payoff mode is never read there.
- A balance edit in the debt dialog (`PUT /debts/:id`, `S/routes/debts.ts:430`) or an unlink sets `balanceSource = manual`. From then on, no Sync touches it ("manual overrides are preserved").
- Logging a payment never changes `debts.balance`. Pending tagged payments are netted on read (`withPendingPayments`).
- Readers: the Amex "Owed" prefers the card's Plaid figure over the debt row (`resolveAmexAnchor`, #651). The Debt tile "$X left" / "% paid", Avalanche rows and Totals, the milestones and Accounts "Owed" read the debt row (every active debt, `inPayoffPopulation`).
- Conclusion: a synced debt equals the card, as the monthly card does live. A ~2.3× gap on the weekly card fits one of two mechanisms:
  - (a) that debt is typed (`manual`): two measures by definition;
  - (b) Plaid returns no liability balance for that card: the plaid-sourced debt stops updating and Owed falls back to the computed anchor.
- Telling them apart needs two live reads: that card's debt `balanceSource` (GET /debts), and its Amex summary `owed.source`.
- Labelled here: Amex `owed.tracked` (the plan's figure, netted as GET /debts nets it, with its source). When it differs from Owed, the Owed figure says "Payoff plan $X · typed, not from the card" (or "· from the card's last sync") and links "Payoff plan" (/avalanche).
- Not labelled: the dashboard Debt tile. The landing has 0 bytes of headroom (see Gates), so any words there need a trim first.
- No figure moves.

## 6. B — checking balance re-verification
- `docs/contracts/checking-balance.md` trace table: every row's named test is present on this tree (28/28 titles found by file). The API ones pass in the full API run and the web ones in the web runs (below).
- The one missing bank evidence: whether the pending rows post at the same amounts. Details keeps saying "Estimate" until they post.

## 7. Tests added or changed
- Unit: `bankReview.test` rule 2u (5 cases) · `evidenceRule.test` skipped target (3) · `planMatch.test` `suggestSkippedPlans` (3).
- API: **new** `skippedOccurrenceSuggestion.integration` (6: Unclear + words + target; ledger suggestion only; Spending unchanged; Match once → forecast matched → Undo exact; Not this keeps the skip; tampered or twice undo refused).
- API: `budgetPlanBySource` (+1, caps = plans) · `amexSummary` (+1 typed debt; `tracked` pinned).
- API, re-pinned with the move stated: `bankingReview` (`byReason.evidence_unresolved` 0, nothing moved) and `expiredHoldsPremium` (Banking Unplanned activity 4 rows / $62.00 out → 3 / $42.00: the pending "transfer out" row is Unconfirmed on Spending; the base-reading line likewise).
- Web: `banking/words.test` (+4, including Banking's words = `evidenceWords` for every unresolved reason) · `bankingReview.test` (+4: the row's words, Match = one write and exact Undo, Not this, member read-only) · `amexSummaryPanel.test` (+2) · **new** `next/moneyMatrix.test.tsx` (2).
- Shared fake: `fakeHouseholdApi` gains an optional `week` (default unchanged).
- Kit (git-ignored, not committed): `FIXTURE_UNCONFIRMED=skipped-loan` (rich2).

## 8. Gates (this commit; own DB `h2budget_test_m`, schema pushed first)
| Gate | Result |
|---|---|
| `pnpm run typecheck` | pass, 0 errors |
| API vitest, full suite (TZ=America/Chicago) | 296 files passed, 2 skipped · 3,436 tests passed, 0 failed, 2 skipped, 7 todo. This includes bankReview, bankingReview, evidenceRule, planMatch, forecastLedger.golden (unchanged), spineParity, moneyPosition and periodBreakdown. |
| New + core files, TZ=UTC | 4 files · 123 passed |
| Web vitest, TZ=America/Chicago | 286 files · 2,946 passed, 2 skipped, 0 errors. A first run alongside the API suite logged one unhandled timer error from `ProposedFixes.tsx`'s focus retry (`bankingFixes.test.tsx`, untouched). Not reproduced alone (3/3) or in this clean rerun. |
| Web vitest, TZ=UTC | 286 files · 2,945 passed, 3 skipped |
| `pnpm run build && node scripts/check-entry-graph.mjs` | OK · landing 622,000 bytes of 622,000 (+0 vs 2a23019e, which is also 622,000) |
| Codegen drift | spec changed → generated src + dist committed; a re-run after the commit leaves the tree clean |
| Headless journey (chromium + webkit · 390 + 1280) | 34/34 + 34/34, two fresh rounds |

## 9. Deviations from the brief
- Rule 2u also outranks a stored "not a planned payment" answer. The live row carries one, so without this the repair would not reach it. The answer stays stored (no write); Match replaces it and Undo restores it.
- `evidenceWords` is mirrored in `banking/words.ts`, not imported. Importing it from a second lazy page split it into its own chunk, and the chunk's name in the landing preload map cost 44 bytes (622,044 > 622,000). A test pins the two equal for every reason.
- A1 needed code (the Budget card); the brief allowed it only if a reader mixed the concepts, and one did.
- Coordinator's row: labelled (Amex page), not repaired; the live reads decide (§5).
- `POST /forecast/resolutions` now runs its unchanged statements in one transaction.

## 10. Doubts for the owner
- The live unconfirmed row carries a stored "not a planned payment" answer. Banking now shows it as Unclear because the bank says loan payment. The decision stays the owner's: Match it to the skipped bill, or file it as something else.
- Weekly plan: set one, or keep the forecast's assumption.
- Amex weekly card: if its debt is typed, re-linking the card (POST /debts/:id/link, adopt) takes the card's figure. Otherwise the payoff plan keeps the typed one.
- Already in tracked files before this pass, and in the git-ignored kit (rich2 "Lrk Loans"): an amount and labels equal to the owner's private facts, e.g. `cashSignalOverdueEvidence.integration.test.ts`. They are in this pass's preview shots too. For the lead's real-value rescan.

## 11. Not done
- Live read-only comparison column (no sign-in here): left for the lead.
- Dashboard Debt tile label: blocked by the landing budget (0 bytes).
- Budget card "spent" vs Spending month "actual" equality: not proven (different readers).
