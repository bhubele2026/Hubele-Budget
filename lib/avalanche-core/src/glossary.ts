// ⭐ (Q1) THE WORDS FOR THE WEEK'S FIGURES — one glossary, in one place.
//
// The owner saw "Counts toward weekly plan" read one figure on Spending and
// a different one on Banking: two figures under one name. Every surface now names
// each figure by what it is, and the server serves each under its own field:
//
//   Counts toward plan   = KNOWN. Confirmed purchases only: the plan's pool
//                          (weekly-flagged + unfiled; for a month, monthly-
//                          flagged) without the UNRESOLVED rows, refunds
//                          netted per account and never below zero.
//                          Wire: `knownWeek` (GET /money/position,
//                          spine.position, the Banking review's household),
//                          `known` (GET /money/period-breakdown).
//                          The plan comparison reads it: `remainingWeekKnown`,
//                          the breakdown's `remaining` / `over` / `withinPlan`.
//   Unconfirmed          = UNRESOLVED. Outflows in the pool with contrary
//                          evidence and no household confirmation (the F2
//                          evidence rule, `evidenceRule.ts`): Plaid says loan
//                          payment / transfer / income, or the forecast only
//                          suggests a bill. "May add up to".
//                          Wire: `unresolvedWeek`, `unresolved.amount`.
//                          `provisional` = unconfirmed > max($25, 5% of the plan).
//   Payments & transfers = confirmed payments and transfers (card payments,
//   (not spending)         debt payments, transfers, bill matches, excluded
//                          categories): money out that is never spending.
//                          Wire: the breakdown's `excludedPayments`.
//   Cautious total       = known + unconfirmed. What the money position still
//   (includes unconfirmed) counts against the cap, so safe-to-spend may read
//                          low, never high.
//                          Wire: `spentWeekDiscretionary` (and the cautious
//                          `remainingWeek`, `withinPlan`, `safeToSpendNow`),
//                          the breakdown's `actual`.
//
//   knownWeek + unresolvedWeek = spentWeekDiscretionary, to the cent, always
//   (`evidenceSplitCents`, periodBreakdown.ts — one call for both endpoints).
//
// A subpath of its own (`@workspace/avalanche-core/glossary`), like
// `freshness`, so a page can import the words without the package root.
// No dependency.

/** The labels a screen uses for each figure (see the header). */
export const WEEK_FIGURE_WORDS = {
  known: "Counts toward plan",
  unresolved: "Unconfirmed",
  payments: "Payments & transfers (not spending)",
  cautious: "Cautious total (includes unconfirmed)",
} as const;

export type WeekFigure = keyof typeof WEEK_FIGURE_WORDS;
