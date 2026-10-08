import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  getGetSpineQueryKey,
  getGetTransactionSplitsQueryKey,
  getListAgentActionsQueryKey,
  getListAgentFindingsQueryKey,
  getListCategorizationReviewQueryKey,
  getListCategoriesQueryKey,
  getListLearnedRulesQueryKey,
  getListPlaidItemsQueryKey,
  type AgentActionList,
  type AgentFindingList,
  type Category,
  type LearnedRule,
  type PlaidItemDetail,
  type ReviewQueue,
  type Spine,
  type TransactionSplits,
} from "@workspace/api-client-react";
import { getGetTransactionsLedgerInfiniteQueryKey, type LedgerPage } from "@workspace/api-client-react/ledger";
import { findingsParams, ledgerParams, DEFAULT_FILTERS, reviewParams } from "@/data/activityData";
import { trailParams } from "@/data/trailQuery";
import { Note } from "@/kit/Note";
import Activity, { type ActivityViewKey } from "@/screens/activity/Activity";

/**
 * ⭐ /design/activity — ACTIVITY ON MADE-UP DATA, for looking at the ledger,
 * the review queue and the rules without signing in. Public, lazy, no network:
 * the query cache is seeded with invented rows under the real keys and every
 * query is switched off, so nothing is fetched. Filing a charge here will fail
 * (there is no server), which is fine for a sample. Labelled "sample".
 */
const NOW = new Date("2026-10-07T15:00:00Z"); // Wednesday, 10:00 in Chicago
const BASE = "/design/activity";

const CATEGORIES = [
  { id: "c1", name: "Groceries", kind: "expense", groupName: "Food", sourceKind: "manual", sortOrder: 1 },
  { id: "c2", name: "Dining out", kind: "expense", groupName: "Food", sourceKind: "manual", sortOrder: 2 },
  { id: "c3", name: "Fuel", kind: "expense", groupName: "Transport", sourceKind: "manual", sortOrder: 1 },
  { id: "c4", name: "Pharmacy", kind: "expense", groupName: "Health", sourceKind: "manual", sortOrder: 1 },
  { id: "c5", name: "Household", kind: "expense", groupName: "Home", sourceKind: "manual", sortOrder: 1 },
  { id: "c6", name: "Paycheck", kind: "income", groupName: "Income", sourceKind: "manual", sortOrder: 1 },
] as Category[];

const row = (
  id: string,
  on: string,
  name: string,
  amount: string,
  categoryId: string | null,
  extra: Record<string, unknown> = {},
) => ({
  id,
  occurredOn: on,
  description: name.toUpperCase(),
  displayName: name,
  merchantSignature: name.toLowerCase(),
  amount,
  categoryId,
  pending: false,
  reimbursable: false,
  reimbursed: false,
  countsInBalance: true,
  plaidAccountId: "acct1",
  ...extra,
});

const LEDGER = {
  rows: [
    row("t1", "2026-10-07", "Corner Market", "-18.40", "c1", { pending: true }),
    row("t2", "2026-10-07", "Coffee Cart", "-6.25", null),
    row("t3", "2026-10-06", "Gas Station", "-41.10", "c3", { categoryProvisional: true }),
    row("t4", "2026-10-06", "Payroll deposit", "1200.00", "c6"),
    row("t5", "2026-10-05", "Big Box Store", "-86.52", "c5", { splitCount: 2 }),
    row("t6", "2026-10-05", "Pharmacy", "-12.99", "c4"),
    row("t7", "2026-10-04", "Pizza Place", "-27.80", "c2"),
  ],
  nextCursor: "next",
  limit: 50,
  matchingCount: 63,
} as unknown as LedgerPage;

const SPINE = {
  asOf: "2026-10-07T14:59:00Z",
  bank: {
    balance: "12345.67",
    asOfDate: "2026-10-07T14:48:00Z",
    source: "plaid",
    lastContactAt: "2026-10-07T14:48:00Z",
    lastFailureAt: null,
    stale: false,
    staleReason: null,
  },
  reviewCount: 0,
} as unknown as Spine;

const REVIEW = {
  total: 3,
  items: [
    {
      decisionId: "d1", transactionId: "t9", occurredOn: "2026-10-03", description: "Hardware Depot", amount: "-64.20", account: "••4421",
      currentCategoryId: null, suggestedCategoryId: "c5", confidence: 0.62, band: "queue", source: "heuristic", explanation: "Suggested from similar charges.",
      createdAt: "2026-10-03T12:00:00Z", flags: { novelMerchant: true, amountAnomaly: false, splitNeedsRebalance: false },
    },
    {
      decisionId: "d2", transactionId: "t10", occurredOn: "2026-10-05", description: "Gas Station", amount: "-97.40", account: "••4421",
      currentCategoryId: "c3", suggestedCategoryId: "c3", confidence: 0.71, band: "provisional", source: "memory", explanation: "You filed this merchant before.",
      createdAt: "2026-10-05T12:00:00Z", flags: { novelMerchant: false, amountAnomaly: true, splitNeedsRebalance: false },
    },
    {
      decisionId: "d3", transactionId: "t11", occurredOn: "2026-10-06", description: "Streaming Service", amount: "-15.99", account: "••4421",
      currentCategoryId: null, suggestedCategoryId: "c5", confidence: 0.7, band: "queue", source: "recurring", explanation: "Looks like a monthly bill.",
      createdAt: "2026-10-06T12:00:00Z", flags: { novelMerchant: false, amountAnomaly: false, splitNeedsRebalance: false },
    },
  ],
} as unknown as ReviewQueue;

const RULES = [
  { id: "r1", signature: "corner market", scope: "merchant", plaidAccountId: null, amountBandLo: null, amountBandHi: null, categoryId: "c1", count: 6, lastConfirmedAt: "2026-10-05T12:00:00Z", disabled: false, source: "user", createdAt: "2026-08-01T12:00:00Z" },
  { id: "r2", signature: "gas station", scope: "merchant_amount", plaidAccountId: null, amountBandLo: "30.00", amountBandHi: "60.00", categoryId: "c3", count: 3, lastConfirmedAt: "2026-09-28T12:00:00Z", disabled: false, source: "user", createdAt: "2026-08-10T12:00:00Z" },
  { id: "r3", signature: "pizza place", scope: "merchant_account", plaidAccountId: "acct1", amountBandLo: null, amountBandHi: null, categoryId: "c2", count: 1, lastConfirmedAt: "2026-09-01T12:00:00Z", disabled: true, source: "user", createdAt: "2026-09-01T12:00:00Z" },
] as unknown as LearnedRule[];

const ACTIONS = {
  actions: [
    { id: "a1", runId: "run1", type: "set_category", targetKind: "transaction", targetId: "t1", outcome: "applied", reversible: true, undoneAt: null, createdAt: "2026-10-07T14:10:00Z" },
    { id: "a2", runId: "run1", type: "set_category", targetKind: "transaction", targetId: "t6", outcome: "applied", reversible: true, undoneAt: null, createdAt: "2026-10-07T14:10:00Z" },
    { id: "a3", runId: "run2", type: "finding", targetKind: "finding", targetId: "f1", outcome: "needs_attention", reversible: false, undoneAt: null, createdAt: "2026-10-06T22:00:00Z" },
    { id: "a4", runId: "run3", type: "remember", targetKind: "merchant", targetId: null, outcome: "applied", reversible: true, undoneAt: "2026-10-06T09:00:00Z", createdAt: "2026-10-05T22:00:00Z" },
  ],
} as unknown as AgentActionList;

const FINDINGS = {
  findings: [
    { id: "f1", kind: "duplicate_charge", severity: "watch", confidence: "estimate", payload: { amount: 18.4, daysApart: 1 }, firstSeen: "2026-10-06T22:00:00Z", lastSeen: "2026-10-07T08:00:00Z", resolvedAt: null, dismissedAt: null },
    { id: "f2", kind: "shortfall_before_income", severity: "high", confidence: "confirmed", payload: { shortfall: 212, paydayDate: "2026-10-09" }, firstSeen: "2026-10-06T22:00:00Z", lastSeen: "2026-10-07T08:00:00Z", resolvedAt: null, dismissedAt: null },
  ],
} as unknown as AgentFindingList;

const PLAID = [
  {
    id: "item1", itemId: "i1", institutionName: "Sample Bank", institutionSlug: "sample", affectedCount: 0,
    accounts: [
      { id: "acct1", accountId: "pa1", name: "Checking", mask: "4421", type: "depository", subtype: "checking" },
      { id: "acct2", accountId: "pa2", name: "Savings", mask: "0198", type: "depository", subtype: "savings" },
    ],
  },
] as unknown as PlaidItemDetail[];

const SPLITS = {
  transactionId: "t5", amount: "-86.52", invalid: false,
  splits: [
    { id: "s1", categoryId: "c5", amount: "-60.00", member: null, note: null, source: "user" },
    { id: "s2", categoryId: "c1", amount: "-26.52", member: null, note: null, source: "user" },
  ],
} as TransactionSplits;

function sampleClient(): QueryClient {
  // Every query off by default: the seeded data renders, nothing is fetched.
  const qc = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, refetchOnMount: false } } });
  const today = "2026-10-07";
  qc.setQueryData(getGetTransactionsLedgerInfiniteQueryKey(ledgerParams(DEFAULT_FILTERS, today)), { pages: [LEDGER], pageParams: [undefined] });
  qc.setQueryData(getListCategoriesQueryKey(), CATEGORIES);
  qc.setQueryData(getListPlaidItemsQueryKey(), PLAID);
  qc.setQueryData(getGetSpineQueryKey(), SPINE);
  qc.setQueryData(getListCategorizationReviewQueryKey(reviewParams), REVIEW);
  qc.setQueryData(getListLearnedRulesQueryKey(), RULES);
  qc.setQueryData(getListAgentActionsQueryKey(trailParams), ACTIONS);
  qc.setQueryData(getListAgentFindingsQueryKey(findingsParams), FINDINGS);
  qc.setQueryData(getGetTransactionSplitsQueryKey("t5"), SPLITS);
  return qc;
}

const client = sampleClient();

// The Automation sample shares this chunk's route (see routePrefetch.ts): loaded on demand.
const AutomationSample = lazy(() => import("./DesignAutomation"));

export default function DesignActivity() {
  const [location] = useLocation();
  if (location.startsWith("/design/automation")) {
    return (
      <Suspense fallback={null}>
        <AutomationSample />
      </Suspense>
    );
  }
  const rest = location.slice(BASE.length);
  const view: ActivityViewKey = rest.startsWith("/review") ? "review" : rest.startsWith("/rules") ? "rules" : "ledger";
  return (
    <QueryClientProvider client={client}>
      <div className="flex flex-col gap-6" data-testid="page-design-activity">
        <Note kind="empty" data-testid="sample-note">
          Sample — every charge on this page is made up.
        </Note>
        <Activity view={view} base={BASE} now={NOW} />
      </div>
    </QueryClientProvider>
  );
}
