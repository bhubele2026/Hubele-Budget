> # ⚠️ HISTORICAL DOCUMENT — DO NOT ACT ON THE "FIXES" BELOW
>
> This is an audit of the app **as it stood in Phase 5**, before the 2026-08
> overhaul. Large parts of the app it describes no longer exist, and every
> recommendation in "Gaps & recommended fixes" has been **closed by removal**
> rather than by implementation. Read it as a record of what was once true.
>
> **Deleted since this was written** — anything citing these is describing a
> feature that is gone, not a gap to fill:
>
> | Removed | By | Cited in |
> | --- | --- | --- |
> | The whole AI/advisor framework (`lib/advisorTools.ts`, `routes/advisorProposals.ts`, `routes/advisorUndo.ts`, `components/advisor-chat.tsx`, `components/advisor-nudge.tsx`, `advisorAudit.integration.test.ts`) | A3 / A4 | M5, M39, M40 |
> | Weekly Debrief (`pages/debrief.tsx`, `lib/weeklyDebrief.ts`, `routes/weeklyDebrief.ts`, the `/debrief` endpoints) | A5 | M17, M22–M28, M47 |
> | The standalone Expo mobile app (`artifacts/h2budget-mobile/`) | overhaul | M42–M45 |
> | Gamification — confetti, Wrapped, health score, savings goal | C1 | M5 and the health-card rows |
> | Dark mode | overhaul | theming rows |
>
> **Still real** and safe to trust: `lib/avalanche-core/src/index.ts`,
> `lib/weeklyStreak.ts`, `lib/behaviorFacts.ts`, and the forecast/avalanche
> rows generally. When in doubt, check the file exists before believing a row.
>
> A fresh audit against the post-overhaul app would be worth doing. This
> document is not it, and should not be quietly edited into it.

# H2 Budget — Manifesto Coverage Audit (Phase 5)

**Mission:** get to **$0 debt as fast as the math allows**, and make the plan so
easy to stay on that you don't quit.

This is a read-only audit of the 50-point manifesto against the current
codebase. Phases 1–3 already shipped: CI (`.github/workflows/ci.yml` —
typecheck + web vitest + api vitest, Playwright opt-in), the shared isomorphic
payoff engine (`lib/avalanche-core/src/index.ts`), and the forecast
decomposition (`artifacts/h2budget/src/pages/forecast/`).

Legend: ✅ implemented · ⚠️ partial · ❌ missing. "Tested?" = a real automated
test exercises the behavior (not merely incidental coverage). All paths are
relative to the repo root.

| #   | point (short) | impl? | tested? | key file(s) |
| --- | --- | :---: | :---: | --- |
| M1  | get to $0 debt fast (coherent payoff plan) | ✅ | yes | `lib/avalanche-core/src/index.ts`, `artifacts/h2budget/src/pages/avalanche.tsx`, `artifacts/h2budget/src/lib/avalanche.test.ts` |
| M2  | ram spare dollars into payoff | ✅ | yes | `lib/avalanche-core/src/index.ts` (extra-pool cascade L209–233), `artifacts/h2budget/src/lib/avalanche.test.ts` |
| M3  | know safe overpay amount weekly | ✅ | yes | `lib/avalanche-core/src/index.ts` (`findExtraForPayoff`), `artifacts/api-server/src/routes/avalanche.ts`, `artifacts/h2budget/src/components/avalanche-ready-card.tsx` |
| M4  | see exact debt-free date | ✅ | yes | `lib/avalanche-core/src/index.ts` (`debtFreeDate` L280–284), `artifacts/h2budget/src/pages/avalanche.tsx` |
| M5  | make the habit easy/sticky | ⚠️ | partial | `artifacts/h2budget/src/components/advisor-nudge.tsx`, `artifacts/h2budget/src/lib/weeklyStreak.ts`, `artifacts/api-server/src/lib/behaviorFacts.ts` |
| M6  | track every debt (balance/rate/min) | ✅ | yes | `artifacts/api-server/src/routes/debts.ts`, `lib/avalanche-core/src/index.ts` (`SimDebt`), `artifacts/api-server/src/__tests__/debtsAprValidation.integration.test.ts` |
| M7  | real % paid off from balance history | ✅ | yes | `artifacts/api-server/src/routes/debts.ts` (`debtBalanceHistoryTable`, `/debts/balance-history`), `artifacts/h2budget/src/pages/debts.tsx`, `artifacts/api-server/src/__tests__/debtsOriginalBalance.integration.test.ts` |
| M8  | auto-link Plaid debt accounts | ✅ | yes | `artifacts/api-server/src/routes/plaid.ts`, `artifacts/h2budget/src/components/post-link-debt-dialog.tsx`, `artifacts/api-server/src/__tests__/plaidCreateDebtFromAccount.integration.test.ts` |
| M9  | Kill Order = next 3 ranked moves | ✅ | yes | `artifacts/h2budget/src/components/dashboard-kill-order.tsx` (`killedOrder.slice(0,3)`) |
| M10 | lock debt minimums as bills | ✅ | yes | `artifacts/api-server/src/lib/debtMinSchedule.ts`, `artifacts/api-server/src/__tests__/billsDebtMin.integration.test.ts` |
| M11 | manual extra payment → new payoff date | ✅ | yes | `artifacts/h2budget/src/pages/avalanche.tsx` (slider drives live sim), `artifacts/h2budget/src/pages/debtsPageTargetExtra.test.tsx` |
| M12 | mirror Chase checking into 90-day forecast | ✅ | yes | `artifacts/h2budget/src/lib/chaseEndingBalance.ts`, `chaseScope.ts`, `artifacts/api-server/src/routes/forecast.ts` |
| M13 | project future balance from bills+income | ✅ | yes | `artifacts/api-server/src/lib/cashSignal.ts`, `artifacts/api-server/src/__tests__/cashSignal.integration.test.ts` |
| M14 | forecast bends around payoff + freed-cash banner | ✅ | yes | `artifacts/h2budget/src/lib/forecastDebts.ts`, `artifacts/h2budget/src/pages/forecast/CashFreedBanner.tsx`, `artifacts/h2budget/src/pages/forecastAccuracy.test.tsx` |
| M15 | per-category monthly budgets | ✅ | yes | `artifacts/h2budget/src/pages/budget.tsx`, `artifacts/api-server/src/routes/budget.ts`, `artifacts/api-server/src/__tests__/budgetCategoryMigration.integration.test.ts` |
| M16 | weekly/monthly/unplanned allowance pools | ✅ | yes | `artifacts/h2budget/src/pages/allowances.tsx`, `artifacts/h2budget/src/lib/weeklyBuckets.ts` |
| M17 | weekly cap burndown → avalanche fuel | ✅ | yes | `artifacts/api-server/src/lib/weeklyDebrief.ts`, `artifacts/api-server/src/routes/weeklySettlements.ts`, `artifacts/api-server/src/routes/avalanche.ts` |
| M18 | trash-talk when allowance blown 2 weeks straight | ✅ | yes | `artifacts/h2budget/src/pages/allowances.tsx` (`roastForStreak`), `artifacts/h2budget/src/lib/weeklyStreak.ts` |
| M19 | reimbursables tagged + path to settle | ✅ | yes | `artifacts/h2budget/src/pages/dashboard.tsx` (`ReimbursementsBox`), `artifacts/h2budget/src/pages/reimbursements-box.test.tsx` |
| M20 | transfers/card-payments excluded from spending | ✅ | yes | `artifacts/api-server/src/lib/spendingFilter.ts`, `artifacts/api-server/src/__tests__/cardPaymentReclassify.integration.test.ts` |
| M21 | review inbox surfaces only what needs attention | ✅ | yes | `artifacts/h2budget/src/hooks/useReviewInboxCount.ts`, `artifacts/h2budget/src/hooks/useReviewInboxCount.test.tsx` |
| M22 | weekly debrief planned-vs-actual | ✅ | yes | `artifacts/api-server/src/lib/weeklyDebrief.ts`, `artifacts/api-server/src/__tests__/weeklyDebrief.integration.test.ts` |
| M23 | top-line income/expenses/net | ✅ | yes | `artifacts/api-server/src/lib/weeklyDebrief.ts` (`totals`/`netSummary`), `artifacts/h2budget/src/pages/debrief.tsx` |
| M24 | per-category variance | ✅ | yes | `artifacts/api-server/src/lib/weeklyDebrief.ts` (`byCategory`), `artifacts/api-server/src/__tests__/weeklyDebrief.integration.test.ts` |
| M25 | category planned = budget sliced to week | ✅ | yes | `artifacts/api-server/src/lib/weeklyDebrief.ts` (monthly ÷ 4) |
| M26 | bills event-based (full amount in due week) | ✅ | yes | `artifacts/api-server/src/lib/cashSignal.ts`, `artifacts/h2budget/src/pages/forecastAccuracy.test.tsx` |
| M27 | lock a finished week | ✅ | yes | `artifacts/api-server/src/routes/weeklyDebrief.ts` (lock/unlock), `artifacts/api-server/src/__tests__/weeklyDebrief.integration.test.ts` |
| M28 | debrief surfaces ONLY open items needing a decision | ⚠️ | partial | `artifacts/api-server/src/lib/weeklyDebrief.ts` (`openItemsCount`), `artifacts/h2budget/src/pages/debrief.tsx` |
| M29 | pull Chase + Amex via Plaid | ✅ | yes | `artifacts/api-server/src/lib/plaidLiabilities.ts`, `artifacts/api-server/src/routes/plaid.ts`, `artifacts/api-server/src/__tests__/plaidExchangeRelinkAmexNoDuplicates.integration.test.ts` |
| M30 | match charges to planned bills (self-correcting) | ✅ | yes | `artifacts/api-server/src/routes/forecast.ts` (`/forecast/resolutions`), `artifacts/h2budget/src/lib/forecastMatch.ts`, `artifacts/h2budget/src/lib/forecastOneClickMatch.test.ts` |
| M31 | one-click/drag-match + reconcile-to-zero confetti | ✅ | yes | `artifacts/h2budget/src/lib/forecastReconcile.ts`, `artifacts/h2budget/src/components/confetti.tsx`, `artifacts/h2budget/src/pages/forecastDragMatch.test.tsx` |
| M32 | de-dupe + heal broken bank links | ✅ | yes | `artifacts/api-server/src/lib/dedupePlaidAccounts.ts`, `dedupeTransactions.ts`, `plaidMalformedSiblingCleanup.ts`, `artifacts/api-server/src/__tests__/dedupePlaidAccounts.integration.test.ts` |
| M33 | auto-categorize w/ learning rules + merchant cleanup | ✅ | yes | `artifacts/api-server/src/lib/autoCategorize.ts`, `merchantNameExtract.ts`, `artifacts/api-server/src/lib/autoCategorize.test.ts`, `artifacts/api-server/src/__tests__/categorization.integration.test.ts` |
| M34 | ignore/exclude-from-budget | ✅ | yes | `artifacts/api-server/src/lib/excludedCategory.ts`, `artifacts/api-server/src/routes/transactions.ts`, `artifacts/api-server/src/__tests__/ignoreCategory.integration.test.ts` |
| M35 | dashboard buckets/streaks/Amex-at-a-glance | ✅ | yes | `artifacts/h2budget/src/pages/dashboard.tsx`, `artifacts/h2budget/src/components/bucket-bubbles.tsx`, `artifacts/h2budget/src/pages/dashboardSourceChips.test.tsx` |
| M36 | reports as motivation hub | ✅ | yes | `artifacts/h2budget/src/pages/reports.tsx` (milestone confetti, killed-milestone timeline, streak board), `artifacts/api-server/src/routes/reports.ts` |
| M37 | "days since" behavior trackers | ✅ | yes | `artifacts/h2budget/src/lib/daysSinceTrackers.ts`, `artifacts/h2budget/src/pages/reports.tsx` (days-since tiles), `artifacts/h2budget/src/pages/settingsTrackerValidation.test.tsx` |
| M38 | under/over-budget streak chips | ✅ | yes | `artifacts/h2budget/src/lib/weeklyStreak.ts`, `artifacts/h2budget/src/pages/reports.tsx`, `artifacts/h2budget/src/pages/allowances.tsx` |
| M39 | AI advisor in-voice that can act | ✅ | partial | `artifacts/api-server/src/lib/advisor.ts` (savage-coach system prompt), `advisorTools.ts` (risk-tiered tools), `artifacts/h2budget/src/components/advisor-chat.tsx` |
| M40 | advisor audit log + proposals (nothing behind your back) | ✅ | yes | `artifacts/api-server/src/lib/advisorTools.ts` (`advisorAuditLogTable`/`advisorProposalsTable`), `artifacts/api-server/src/routes/advisorProposals.ts`, `advisorUndo.ts`, **`artifacts/api-server/src/__tests__/advisorAudit.integration.test.ts`** |
| M41 | household-scoped | ✅ | yes | `artifacts/api-server/src/middlewares/requireAuth.ts` + `req.householdId` in 20/25 routes, `artifacts/api-server/src/__tests__/invitations.integration.test.ts` |
| M42 | iPhone home glance + quick categorize | ⚠️ | **no** | `artifacts/h2budget-mobile/app/(tabs)/home.tsx`, `artifacts/h2budget-mobile/app/(tabs)/transactions.tsx` |
| M43 | mobile: same streaks + skeleton-fast loads | ✅ | **no** | `artifacts/h2budget-mobile/app/(tabs)/home.tsx` (`weeklyStreak`, streak chip), `artifacts/h2budget-mobile/components/Skeleton.tsx` |
| M44 | one-step unlock (Clerk) | ✅ | **no** | `artifacts/h2budget-mobile/app/_layout.tsx` (`ClerkProvider`), `app/sign-in.tsx`, `lib/tokenCache.ts` |
| M45 | web↔phone sync | ✅ | partial | `artifacts/h2budget-mobile/lib/api.ts` (shared backend routes + Clerk token), `artifacts/api-server/src/routes/*` |
| M46 | income→reserve→leftover is avalanche ammo | ✅ | yes | `artifacts/api-server/src/routes/avalanche.ts` (`budget_net` extra source), `artifacts/h2budget/src/pages/avalanche.tsx` |
| M47 | debrief tells how much ammo freed | ⚠️ | partial | `lib/avalanche-core/src/index.ts` (`minFreed`), `artifacts/h2budget/src/pages/avalanche.tsx`; **not** in `artifacts/h2budget/src/pages/debrief.tsx` |
| M48 | avalanche fires at highest-APR | ✅ | yes | `lib/avalanche-core/src/index.ts` (`targetIndex`, avalanche branch L103–104), `artifacts/h2budget/src/lib/avalanche.test.ts` |
| M49 | each kill feeds the next | ✅ | yes | `lib/avalanche-core/src/index.ts` (freed min → `pool` L199; kill detection L235–249) |
| M50 | repeat to $0 | ✅ | yes | `lib/avalanche-core/src/index.ts` (main loop to `totalBalanceEnd <= CENTS`), `artifacts/h2budget/src/lib/avalanche.test.ts` |

**Tally:** ✅ 44 · ⚠️ 5 (M5, M28, M42, M45, M47) · ❌ 0. M40 is implemented
**and tested** (`advisorAudit.integration.test.ts` exercises the full
proposal → confirm → audit → undo path across every write tool, plus
cancel-never-executes and cross-household scoping). The standalone Expo mobile
app (M42–M45) has **no** tests at all.

---

## Gaps & recommended fixes — ALL CLOSED BY REMOVAL (2026-08)

⚠️ **Every gap this section once listed pointed at a feature that has since been
deleted.** They were closed by the overhaul deciding the feature should not
exist, not by anyone implementing the fix. The original tally read
"✅ 44 · ⚠️ 5 (M5, M28, M42, M45, M47) · ❌ 0"; here is what actually became of
those five:

| Gap | Recommended fix at the time | What happened |
| --- | --- | --- |
| **M5** — habit stickiness | "add a re-engagement nudge + streak-at-risk warning" | The nudge card it was built on (`components/advisor-nudge.tsx`) was deleted with the AI strip (A3), and gamification went in C1. `weeklyStreak.ts` and `behaviorFacts.ts` survive; no nudge was ever built. **Not a gap — a scope decision.** |
| **M28** — debrief shows only open items | "add a decision-only filter to `debrief.tsx`" | Weekly Debrief was removed entirely (A5). `debrief.tsx` and `weeklyDebrief.ts` do not exist. **Moot.** |
| **M42** — iPhone home glance | "build a WidgetKit widget, or scope M42 to the in-app glance" | `artifacts/h2budget-mobile/` was deleted. There is no mobile app to widget. **Moot.** |
| **M45** — web↔phone sync | "add a mobile/web contract test" | Same — there is no second client to hold a contract with. **Moot.** |
| **M47** — debrief reports freed ammo | "add a freed-for-the-avalanche figure to the debrief" | The debrief is gone. Freed minimums still surface on the avalanche page via `minFreed`. **Moot.** |

The M40 entry below (advisor audit log, ✅ + tested) is likewise historical: the
audit machinery and its integration test were removed with the advisor
framework, so nothing in the app writes an advisor audit log any more — because
nothing in the app is an advisor.

