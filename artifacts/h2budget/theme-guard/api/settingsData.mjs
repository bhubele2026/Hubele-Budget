// What the Settings tabs (and the small pages beside them: allowances, wish
// list, mapping rules) read. Every name, address and figure is made up.
import * as fx from "./fixture.mjs";
import * as L from "./ledger.mjs";

/** GET /api/settings: the household's allowances and the names it gave its cards. */
export const settings = {
  weeklyAllowanceAmount: "325.00",
  monthlyAllowanceAmount: "400.00",
  unplannedAllowanceAmount: "0.00",
  primaryAccount: L.CHECKING.name,
  preferences: {
    amexCardNames: Object.fromEntries(L.CARDS.map((c) => [c.externalId, c.name])),
    amexCardBrands: Object.fromEntries(L.CARDS.map((c) => [c.externalId, c.brand])),
    amexCardCadence: Object.fromEntries(L.CARDS.map((c) => [c.externalId, c.cadence])),
    daysSinceTrackers: [{ id: "dst-takeout", label: "Takeout", matchType: "keyword", matchValue: "LANTERN THAI" }],
  },
};

const at = (day, time = "15:00:00") => `${day}T${time}.000Z`;
const ms = (day) => Date.parse(at(day));

const members = [
  { id: "user_fixture_alex", email: "alex@example.com", displayName: "Alex", imageUrl: null, isOwner: true, createdAt: ms("2026-05-01"), lastSignInAt: ms("2026-11-10") },
  { id: "user_fixture_sam", email: "sam@example.com", displayName: "Sam", imageUrl: null, isOwner: false, createdAt: ms("2026-05-03"), lastSignInAt: ms("2026-11-08") },
];
const invitations = [
  { id: "inv-1", emailAddress: "jordan@example.com", status: "pending", createdAt: ms("2026-11-06"), updatedAt: ms("2026-11-06"), url: null, revoked: false },
  { id: "inv-2", emailAddress: "casey@example.com", status: "expired", createdAt: ms("2026-08-02"), updatedAt: ms("2026-09-01"), url: null, revoked: false },
];

const plan = (id, period, amount) => ({ id, memberUserId: null, period, amount, effectiveFrom: "2026-09-06", source: "owner", derivation: null, createdAt: at("2026-09-05") });
const WEEKLY = plan("plan-week", "weekly", "325.00");
const MONTHLY = plan("plan-month", "monthly", "400.00");
const allowancePlans = {
  plans: [WEEKLY, MONTHLY, { ...plan("plan-week-old", "weekly", "300.00"), effectiveFrom: "2026-05-03", createdAt: at("2026-05-02") }],
  suggested: {
    weekly: "340.00",
    derivation: { takeHomeMonthly: "9381.67", committedMonthly: "4460.00", debtMinimumsMonthly: "841.00", extraMonthly: "2600.00", goalsMonthly: "0.00", discretionaryMonthly: "1480.67" },
  },
  inEffect: { weekly: WEEKLY, monthly: MONTHLY },
  prefills: [
    { period: "weekly", amount: "340.00", source: "suggested", label: "Suggested from income and bills" },
    { period: "monthly", amount: "400.00", source: "settings", label: "Your earlier monthly allowance" },
  ],
};

const recent = (n, txnId, source, band, resolution, resolvedBy = null) => {
  const t = L.byId(txnId);
  return {
    id: `cd-${n}`,
    transactionId: t.id,
    description: t.description,
    amount: t.amount,
    occurredOn: t.occurredOn,
    source,
    band,
    categoryId: t.categoryId,
    categoryName: L.categoryName(t.categoryId),
    resolution,
    resolvedBy,
    decidedAt: at(t.occurredOn, "23:10:00"),
    undoable: band === "auto",
  };
};
const categorizationSettings = {
  autoCategorize: true,
  modelAutoCategorize: false,
  ai: { configured: true, enabled: true },
  engine: { rules: 10, learned: 6, memories: 3, recurring: 22 },
  model: {
    mode: "suggest",
    eligible: false,
    judged: 38,
    verified: 34,
    unreviewed: 4,
    requirements: [
      { key: "ai", label: "AI is on", met: true, current: 1, target: 1 },
      { key: "owner_switch", label: "You turned it on", met: false, current: 0, target: 1 },
      { key: "judged", label: "Suggestions you have judged", met: false, current: 38, target: 50 },
      { key: "accuracy", label: "Right, of the last 50", met: false, current: 34, target: 45 },
    ],
    accuracy: { last50: { right: 34, judged: 38 }, last20: { right: 18, judged: 20 } },
  },
  recent: [
    recent(1, "txn-ca-1113", "rule", "auto", "unreviewed"),
    recent(2, "txn-ca-1112", "memory", "auto", "accepted", "silent"),
    recent(3, "txn-ca-1115", "model", "provisional", "unreviewed"),
    recent(4, "txn-cb-1105", "heuristic", "auto", "corrected", "user"),
    recent(5, "txn-ca-1110", "recurring", "auto", "accepted", "user"),
  ],
  reviewCount: 4,
  backlog: { unfiled: 2, oldestUnfiledOn: "2026-11-09", provisional: 2 },
  banks: L.plaidItems.map((it) => ({ itemId: it.id, name: it.institutionName, lastDataOn: fx.TODAY, lastSyncedAt: fx.SNAPSHOT_AT, autoUpdates: { on: true, reason: "ok" } })),
};

const learnedRules = [
  ["lr-1", "corner grocer", "merchant", "cat-groceries", 14],
  ["lr-2", "lantern thai kitchen", "merchant", "cat-dining", 9],
  ["lr-3", "hilltop fuel", "merchant", "cat-fuel", 11],
  ["lr-4", "sundial hardware", "merchant_account", "cat-home-repair", 6],
  ["lr-5", "willow creek dental", "merchant", "cat-health", 3],
  ["lr-6", "threadline clothing", "merchant_amount", "cat-dining", 2],
].map(([id, signature, scope, categoryId, count], i) => ({
  id,
  signature,
  direction: "out",
  scope,
  plaidAccountId: scope === "merchant_account" ? L.CARD_A.externalId : null,
  amountBandLo: scope === "merchant_amount" ? "25.00" : null,
  amountBandHi: scope === "merchant_amount" ? "100.00" : null,
  categoryId,
  count,
  lastConfirmedAt: at(fx.addDays(fx.TODAY, -(i * 4 + 1))),
  disabled: id === "lr-6",
  source: "correction",
  createdAt: at("2026-06-01"),
}));

const memory = {
  memories: [
    { id: "mem-1", scope: "spending", key: "weekly_groceries", value: { text: "Groceries are bought on Saturdays at Freshfield Market." }, source: "user_stated", createdByKind: "user", memberUserId: null, updatedAt: at("2026-10-02") },
    { id: "mem-2", scope: "categorization", key: "market_stalls", value: { text: "Market stalls are food: file them under Groceries." }, source: "agent_proposed", createdByKind: "agent", memberUserId: null, updatedAt: at("2026-11-09") },
    { id: "mem-3", scope: "debt", key: "extra_target", value: { text: "The extra payment goes to the highest rate first." }, source: "inferred", createdByKind: "agent", memberUserId: null, updatedAt: at("2026-09-14") },
  ],
};

const recapTexts = [
  ["2026-11-10", "Good morning. Checking has what this week needs. $212 is left of the weekly plan. The gas bill is due Thursday."],
  ["2026-11-09", "Good morning. Two charges on Card A are waiting for a category. The internet bill has not posted yet."],
  ["2026-11-06", "Good morning. Friday's paycheck landed. The lowest point ahead is Dec 1, still above the buffer."],
  ["2026-11-05", "Good morning. Car insurance looks paid. Nothing else is due today."],
];
const recapHistory = recapTexts.map(([forDate, text], i) => ({
  id: `recap-${forDate}`,
  forDate,
  text,
  source: i === 3 ? "template" : "model",
  status: "previewed",
  generatedAt: at(forDate, "13:00:00"),
  delivery: { status: "previewed", provider: "console", createdAt: at(forDate, "13:00:05") },
}));
const recapDeliveries = [
  ...recapTexts.map(([forDate], i) => ({ id: `del-${forDate}`, kind: "scheduled", forDate, status: i === 2 ? "failed" : "previewed", provider: "console", createdAt: at(forDate, "13:00:05") })),
  { id: "del-test", kind: "test", forDate: null, status: "previewed", provider: "console", createdAt: at("2026-11-04", "20:15:00") },
];
const recapSettings = {
  enabled: true,
  delivery: {
    mode: "preview",
    providerConfigured: false,
    phoneVerified: true,
    scheduled: true,
    sendTimeLocal: "07:00",
    timezone: "America/Chicago",
    lastDelivery: { status: "previewed", provider: "console", at: at("2026-11-10", "13:00:05") },
  },
  sendTimeLocal: "07:00",
  timezone: "America/Chicago",
  phoneLast4: "0142",
  verified: true,
  pausedUntil: null,
  skipWeekends: true,
  extraAlerts: false,
  consentedAt: at("2026-09-01"),
  optedOutAt: null,
  consentText: "Send me one text each morning about my household's money. Reply STOP to end.",
  consentTextVersion: "2026-09",
};

const run = (id, kind, trigger, status, day, summary, cost) => ({ id, kind, trigger, status, startedAt: at(day, "06:05:00"), finishedAt: at(day, "06:05:09"), summary, inputTokens: 4200, outputTokens: 380, costUsd: cost });
const aiUsage = {
  month: "2026-11",
  monthToDateUsd: 1.84,
  calls: 46,
  failures: 1,
  blocked: 0,
  cacheHitRatio: 0.62,
  byTask: [
    { task: "categorize", costUsd: 0.71, calls: 28, failures: 0 },
    { task: "chat", costUsd: 0.58, calls: 6, failures: 0 },
    { task: "recap", costUsd: 0.41, calls: 9, failures: 1 },
    { task: "monitor", costUsd: 0.14, calls: 3, failures: 0 },
  ],
  budget: { monthlyCapUsd: 10, hardCapUsd: 15, dailyCaps: { chat: 1, categorize: 0.5, recap: 0.25 }, pausedUntil: null },
  recentRuns: [
    run("run-nightly-1109", "categorize", "txn_arrived", "succeeded", "2026-11-10", "Filed 1 charge, asked about 2.", 0.03),
    run("run-ask-1109", "chat", "user", "succeeded", "2026-11-09", "Answered: are we okay this week?", 0.11),
    run("run-recap-1109", "recap", "schedule", "succeeded", "2026-11-09", "Wrote the morning text.", 0.04),
    run("run-recap-1106", "recap", "schedule", "failed", "2026-11-06", "The provider did not answer.", null),
    run("run-monitor-1108", "monitor", "schedule", "succeeded", "2026-11-08", "One bill is running higher than planned.", 0.05),
  ],
};

const importHistory = {
  items: [
    {
      batchId: "imp-2026-05-02",
      fileName: "household-budget.xlsx",
      importedAt: at("2026-05-02", "14:10:00"),
      counts: { transactions: 412, categories: 16, debts: 5, recurring: 22 },
      replaced: null,
      snapshotId: null,
      restoredAt: null,
      restore: "too_old",
    },
  ],
};

const wish = (id, title, amount, categoryId, requestedBy, daysAgo, decision, targetDate = null) => ({
  id,
  title,
  amount,
  url: null,
  categoryId,
  targetDate,
  requestedBy,
  requestedAt: at(fx.addDays(fx.TODAY, -daysAgo)),
  waitingUntil: at(fx.addDays(fx.TODAY, 7 - daysAgo)),
  waitingDaysLeft: Math.max(0, 7 - daysAgo),
  decision,
  decidedAt: decision === "pending" ? null : at(fx.addDays(fx.TODAY, -1)),
});
const wishlist = {
  waitDays: 7,
  items: [
    wish("wish-1", "Standing desk", 349, "cat-home-repair", "Alex", 2, "pending"),
    wish("wish-2", "Weekend at the lake cabin", 540, "cat-travel", "Sam", 9, "pending", "2027-02-13"),
    wish("wish-3", "Dog bed", 64, "cat-pets", "Sam", 12, "bought"),
    wish("wish-4", "Espresso machine", 420, "cat-dining", "Alex", 20, "declined"),
  ],
};

export const GET_EXACT = {
  "/api/members": () => members,
  "/api/invitations": () => invitations,
  "/api/allowance-plans": () => allowancePlans,
  "/api/categorization/settings": () => categorizationSettings,
  "/api/learned-rules": () => learnedRules,
  "/api/memory": () => memory,
  "/api/recap/settings": () => recapSettings,
  "/api/recap/history": () => recapHistory,
  "/api/recap/deliveries": () => recapDeliveries,
  "/api/ai/usage/summary": () => aiUsage,
  "/api/import/history": () => importHistory,
  "/api/wishlist": () => wishlist,
};
export const GET_PATTERNS = [];
export const QUIET_EMPTY = {};
