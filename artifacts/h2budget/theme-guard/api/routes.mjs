// Every page fixture's routes, gathered for the middleware.
import * as fx from "./fixture.mjs";
import * as L from "./ledger.mjs";
import * as plan from "./plan.mjs";
import * as sp from "./spending.mjs";
import * as ai from "./assistant.mjs";
import * as st from "./settingsData.mjs";
import { whatsNewMe } from "./whatsNew.mjs";
import { needsYou } from "./needsYou.mjs";

/** GET: pathname → (query) => body */
export const GET_EXACT = {
  "/api/whats-new/me": () => whatsNewMe(),
  "/api/healthz": () => ai.health,
  "/api/settings": () => st.settings,
  // money, ledgers
  "/api/transactions": (q) => L.listTransactions(q),
  "/api/transactions/ledger": (q) => L.ledgerPage(q),
  "/api/transactions/balances": (q) => L.ledgerBalances(q),
  "/api/banking/review": (q) => sp.bankingReview(q),
  "/api/banking/needs-you": () => needsYou(),
  "/api/money/period-breakdown": (q) => sp.periodBreakdown(q),
  "/api/amex/weekly-payoff": (q) => sp.amexWeeklyPayoff(q),
  "/api/amex/summary": (q) => sp.amexSummary(q),
  "/api/plaid/items": () => L.plaidItems,
  "/api/plaid/liability-accounts": () => L.liabilityAccounts,
  "/api/plaid/environment": () => ai.plaidEnvironment,
  "/api/review/proposals": () => ai.reviewProposals,
  "/api/forecast/duplicate-transaction-count": () => ({ duplicateCount: 0 }),
  // plan
  "/api/debts": () => plan.debts,
  "/api/debts/balance-history": () => plan.debtBalanceHistory(),
  "/api/debt-plan": () => plan.debtPlan(),
  "/api/bills/summary": (q) => plan.billsSummary(q),
  "/api/dashboard": () => plan.dashboard(),
  "/api/reports/spending-facts": (q) => plan.spendingFacts(q),
  "/api/reports/budget-facts": (q) => plan.budgetFacts(q),
  "/api/reports/behavior-facts": (q) => plan.behaviorFacts(q),
  "/api/mapping-rules": () => plan.mappingRules,
  "/api/categorization/review": () => plan.categorizationReview(),
  "/api/categorization/review/count": () => ({ total: plan.categorizationReview().total }),
  // Ask and the agent
  "/api/ai/conversations": () => ({ conversations: ai.conversations }),
  "/api/agent/proposals": (q) => ai.proposals(q),
  "/api/agent/findings": () => ai.findings,
  "/api/agent/actions": () => ai.actions,
  ...st.GET_EXACT,
};
/** GET with a path parameter: [RegExp, (match, query) => body | undefined (→ 404)] */
export const GET_PATTERNS = [
  [/^\/api\/budget\/months\/(\d{4}-\d{2}-\d{2})$/, (m) => plan.budgetMonth(m[1])],
  [/^\/api\/ai\/conversations\/([^/]+)$/, (m) => ai.conversation(decodeURIComponent(m[1]))],
  [/^\/api\/transactions\/([^/]+)$/, (m) => (L.byId(decodeURIComponent(m[1])) ? L.pub(L.byId(decodeURIComponent(m[1]))) : undefined)],
  ...st.GET_PATTERNS,
];
/** Known paths answered with a fixed empty-but-valid body, without a log line. */
export const QUIET_EMPTY = {
  "/api/whats-new": { notes: [], unread: 0 },
  ...st.QUIET_EMPTY,
};
/** Writes with a shaped answer. Everything else answers `{ ok: true }`. Nothing is stored. */
export const WRITES = {
  exact: {
    "POST /api/whats-new/read": (body) => ({ ids: Array.isArray(body.ids) ? body.ids : [] }),
    "POST /api/ai/conversations": () => ai.conversations[0],
  },
  patterns: [],
};
