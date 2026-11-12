// Ask, the suggestions and "handled by H2" for the invented household: one
// short conversation, two open proposals, two findings. Every word is made up.
import * as fx from "./fixture.mjs";

const RUN = "run-ask-1109";
export const conversations = [
  { id: "conv-week", title: "Are we okay this week?", createdAt: "2026-11-09T23:12:00.000Z", lastMessageAt: "2026-11-09T23:14:30.000Z" },
  { id: "conv-flights", title: "Can the holiday flights fit?", createdAt: "2026-11-05T01:40:00.000Z", lastMessageAt: "2026-11-05T01:42:10.000Z" },
];
const MESSAGES = {
  "conv-week": [
    { id: "m1", role: "user", content: { text: "Are we okay this week?" }, runId: null, createdAt: "2026-11-09T23:12:00.000Z" },
    {
      id: "m2",
      role: "assistant",
      content: {
        text: "Yes. Checking has $2,475.90 today, and the weekly plan has $212.00 left of $325.00 through Saturday. The lowest point in the next 90 days is $542.90 on Dec 1, the day rent leaves, which is still above the $500.00 buffer.",
        grounded: true,
      },
      runId: "run-ask-1109a",
      createdAt: "2026-11-09T23:12:20.000Z",
    },
    { id: "m3", role: "user", content: { text: "Dining keeps running high. What would you change?" }, runId: null, createdAt: "2026-11-09T23:14:00.000Z" },
    {
      id: "m4",
      role: "assistant",
      content: {
        text: "Dining & fun has gone over its line three months running. I would raise the line to what you really spend instead of missing it every month. I have put that below as a suggestion; nothing changes unless you approve it.",
        grounded: true,
      },
      runId: RUN,
      createdAt: "2026-11-09T23:14:30.000Z",
    },
  ],
  "conv-flights": [
    { id: "f1", role: "user", content: { text: "Can the holiday flights fit this month?" }, runId: null, createdAt: "2026-11-05T01:40:00.000Z" },
    {
      id: "f2",
      role: "assistant",
      content: { text: "They fit. The $640.00 for flights on Nov 24 is already in the forecast, and the lowest point stays above the buffer.", grounded: true },
      runId: "run-ask-1105",
      createdAt: "2026-11-05T01:42:10.000Z",
    },
  ],
};
export function conversation(id) {
  const c = conversations.find((x) => x.id === id);
  return c ? { conversation: c, messages: MESSAGES[id] ?? [] } : undefined;
}

const P = (id, kind, status, payload, rationale, extra = {}) => ({
  id,
  kind,
  status,
  payload,
  rationale,
  runId: extra.runId ?? "run-nightly-1109",
  decidedBy: extra.decidedBy ?? null,
  decidedAt: extra.decidedAt ?? null,
  appliedActionId: extra.appliedActionId ?? null,
  expiresAt: "2026-11-23T06:00:00.000Z",
  createdAt: extra.createdAt ?? "2026-11-09T23:14:30.000Z",
});
const PROPOSALS = [
  P("prop-dining", "budget_line", "proposed", { label: "Dining & fun · monthly line", before: 420, after: 480, categoryId: "cat-dining" }, "Dining & fun has gone over its line three months running, by about $60 each time.", { runId: RUN }),
  P("prop-stall", "set_category", "proposed", { label: "Market Stall 44 · $27.00", before: null, after: "cat-groceries", txnId: "txn-ca-1116" }, "A market stall on a Monday morning: most likely food."),
  P("prop-weekly", "weekly_limit", "applied", { label: "Weekly plan", before: 300, after: 325 }, "Groceries rose about $25 a week since September.", { decidedBy: "Alex", decidedAt: "2026-10-12T15:00:00.000Z", appliedActionId: "act-3", createdAt: "2026-10-11T23:10:00.000Z" }),
  P("prop-gas", "bill_amount", "rejected", { label: "Gas · Lakeside Energy", before: 88, after: 104 }, "The last two gas bills were higher than the plan's estimate.", { decidedBy: "Alex", decidedAt: "2026-10-20T15:00:00.000Z", createdAt: "2026-10-19T23:10:00.000Z" }),
];
export function proposals(q) {
  const status = q.get("status") ?? "proposed";
  return { proposals: status === "all" ? PROPOSALS : PROPOSALS.filter((p) => p.status === status) };
}

export const findings = {
  findings: [
    {
      id: "find-gas",
      kind: "bill_increase",
      severity: "watch",
      confidence: "confirmed",
      payload: { bill: "Gas · Lakeside Energy", plannedAmount: 88, lastAmount: 104.2, monthsHigher: 2 },
      firstSeen: "2026-10-13T12:00:00.000Z",
      lastSeen: "2026-11-09T12:00:00.000Z",
      resolvedAt: null,
      dismissedAt: null,
    },
    {
      id: "find-dining",
      kind: "category_acceleration",
      severity: "info",
      confidence: "estimate",
      payload: { category: "Dining & fun", usualAmount: 420, thisMonthSoFarAmount: 221.75, daysIntoMonth: 10 },
      firstSeen: "2026-11-08T12:00:00.000Z",
      lastSeen: "2026-11-09T12:00:00.000Z",
      resolvedAt: null,
      dismissedAt: null,
    },
  ],
};
const A = (id, type, targetKind, targetId, outcome, createdAt, reversible = false) => ({ id, runId: "run-nightly-1109", type, targetKind, targetId, outcome, reversible, undoneAt: null, createdAt });
export const actions = {
  actions: [
    A("act-1", "set_category", "transaction", "txn-ca-1113", "applied", "2026-11-10T06:05:00.000Z", true),
    A("act-2", "propose", "proposal", "prop-stall", "proposed", "2026-11-10T06:05:10.000Z"),
    A("act-3", "finding", "finding", "find-gas", "needs_attention", "2026-11-09T06:05:00.000Z"),
    A("act-4", "recap", "recap", null, "applied", "2026-11-09T13:00:00.000Z"),
  ],
};

export const health = {
  status: "ok",
  version: "dev",
  jobs: { mode: "on", started: true, failedLast24h: 0, dlq: 0 },
  ai: { enabled: true, configured: true, provider: "fake" },
  sms: { provider: "console", configured: false, mode: "preview" },
  plaid: { webhookUrlSet: true },
};
export const plaidEnvironment = { env: "production", configured: true, configError: null, nonProdItemCount: 0, nonProdItems: [] };
/** GET /api/review/proposals: one fix H2 proposes (the car insurance row it takes as paid). */
export const reviewProposals = {
  window: { from: fx.addDays(fx.TODAY, -30), to: fx.TODAY, days: 30 },
  count: 1,
  truncated: false,
  items: [
    {
      key: "bill_match:ri-car-ins|2026-11-05",
      proposalHash: "fixture-hash-1",
      kind: "bill_match",
      rows: [
        {
          id: "txn-oakmont-auto-1105",
          date: "2026-11-05",
          displayName: "Oakmont Mutual Auto payment",
          description: "OAKMONT MUTUAL AUTO PMT",
          amount: "-186.00",
          pending: false,
          source: "plaid",
          account: { id: fx.CHECKING.rowId, institution: fx.CHECKING.institution, name: fx.CHECKING.name, mask: fx.CHECKING.mask, externalId: fx.CHECKING.externalId },
          category: { id: "cat-insurance", name: "Insurance" },
          occurrence: { planKey: "ri-car-ins|2026-11-05", recurringItemId: "ri-car-ins", occurrenceDate: "2026-11-05" },
        },
      ],
      rowCount: 1,
      truncated: false,
      total: "-186.00",
      evidence: [
        { field: "bill_suggestion", value: "Car insurance · Oakmont Mutual" },
        { field: "amount_match", value: "186.00" },
        { field: "name_match", value: "OAKMONT MUTUAL" },
      ],
      action: { code: "confirm_bill_match", target: { kind: "bill", id: "ri-car-ins", label: "Car insurance · Oakmont Mutual", categoryId: "cat-insurance", categoryName: "Insurance" } },
      applyWith: ["review_mark_matched"],
    },
  ],
};
