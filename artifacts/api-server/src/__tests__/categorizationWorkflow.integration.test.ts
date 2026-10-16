// ⭐ (Task 7, V) AI CATEGORIZATION AND THE MORNING RECAP, WALKED THROUGH THE
// REAL ROUTES — fixture / provider-mocked verification.
//
// The model is scripted per test at the provider boundary
// (`_helpers/scriptedCategorizer.ts` over `AI_PROVIDER=fake`): suggestion,
// empty, malformed, timeout, api_error, rate_limited. Everything from
// runStructured down — validation, bands, the review queue, Accept / Skip /
// Undo, the agent trail, the usage ledger — is the production code. Nothing
// here says what the real model would answer.
//
//   1. POST /categorization/run: the deterministic stages file what they can
//      (a mapping rule) and hand the rest to the model job;
//   2. the job asks the scripted model; its suggestions wait in
//      GET /categorization/review (and /review/count);
//   3. the morning recap, through POST /recap/preview, /recap/generate-now and
//      the scheduled send, quotes the spine's figures and the review counts,
//      and goes out through the console transport only (nothing sent);
//   4. Accept files the row (period breakdown, Amex summary, review count
//      move); Skip leaves the row exactly as it was and records the answer;
//      Undo puts the row back exactly;
//   5. a locked row, a typed category and a rule-filed row are never asked
//      about and never move: precedence locked > (refund) > memory > rule >
//      recurring > inherited > heuristic > model;
//   6. each failure kind leaves every row unchanged, records the failure on
//      the run and in the usage ledger, and stops after one call (no storm).
//
// Real Postgres (isolated DB), JOBS_MODE=off (the job handler is called
// directly with what the route emitted). Synthetic data only.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";

const OWNER = `v-cat-${process.pid}-${randomUUID().slice(0, 8)}`;
const HOUSEHOLDS: Record<string, string> = {};

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { headers: Record<string, unknown>; userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    const who = String(req.headers["x-test-user"] ?? OWNER);
    req.userId = who;
    req.actualUserId = who;
    req.householdId = HOUSEHOLDS[who];
    req.householdOwnerId = who;
    next();
  },
}));

import {
  db,
  agentRunsTable,
  aiUsageTable,
  budgetCategoriesTable,
  categoryDecisionsTable,
  mappingRulesTable,
  plaidAccountsTable,
  plaidItemsTable,
  recapDeliveriesTable,
  recapSettingsTable,
  recapsTable,
  transactionsTable,
} from "@workspace/db";
import { householdToday, weekBounds } from "@workspace/avalanche-core";
import fullRouter from "../routes";
import { fakeCalls, resetFake } from "../ai/fake";
import { invalidateTaskConfigCache } from "../ai/config";
import { _emittedForTests } from "../jobs/emit";
import { QUEUES } from "../jobs/queues";
import { categorizeSendOptions, runCategorizeJob, type CategorizeJobData } from "../jobs/handlers/categorize";
import { sendScheduledRecap } from "../jobs/handlers/recapJobs";
import { listReviewQueue } from "../lib/categorizer/review";
import { registerCategorizationReviewCount } from "../recap/facts";
import { getSmsConfig, getSmsProvider } from "../lib/sms";
import { sentSms } from "../lib/sms/fake";
import { pinEnv } from "./_helpers/aiEnv";
import { createTestHousehold } from "./_helpers/testHousehold";
import { fixtureBy } from "./_helpers/aiCategorize";
import { scriptCategorizer, type ScriptedKind } from "./_helpers/scriptedCategorizer";

pinEnv({
  AI_ENABLED: "true",
  AI_PROVIDER: "fake",
  JOBS_MODE: undefined,
  // The console transport is the only one: nothing that could put a text on a phone.
  SMS_PROVIDER: undefined,
  TWILIO_ACCOUNT_SID: undefined,
  TWILIO_AUTH_TOKEN: undefined,
  TWILIO_FROM: undefined,
  TWILIO_MESSAGING_SERVICE_SID: undefined,
});

// ── The server: the real router under /api ───────────────────────────────────
const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use("/api", fullRouter);
let server: Server;
let base = "";
async function api(method: string, path: string, body?: unknown, who = OWNER) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { "content-type": "application/json", "x-test-user": who },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as any };
}

// ── The household ────────────────────────────────────────────────────────────
const TODAY = householdToday(new Date());
const WEEK = weekBounds(TODAY);
const RUN = randomUUID().slice(0, 8);
let HH = "";
const CARD = `v-cat-card-${RUN}`;
const cat: Record<string, string> = {};
const row: Record<string, string> = {};

async function seedCard(householdId: string, owner: string, accountId: string) {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({ userId: owner, householdId, itemId: `item-${accountId}`, accessToken: `access-sandbox-${accountId}`, institutionName: "Synthetic Card Co", institutionSlug: "amex" })
    .returning();
  await db
    .insert(plaidAccountsTable)
    .values({ userId: owner, householdId, itemId: item!.id, accountId, name: "Synth Gold Card", mask: "0202", type: "credit", subtype: "credit card" });
}
async function addCardRow(householdId: string, owner: string, accountId: string, description: string, amount: string, extra: Partial<typeof transactionsTable.$inferInsert> = {}) {
  const [t] = await db
    .insert(transactionsTable)
    .values({
      userId: owner,
      householdId,
      occurredOn: TODAY,
      description,
      amount,
      source: "plaid:amex",
      plaidAccountId: accountId,
      plaidTransactionId: `v-cat-${randomUUID()}`,
      weeklyAllowance: true,
      ...extra,
    })
    .returning({ id: transactionsTable.id });
  return t!.id;
}
const txn = async (id: string) => (await db.select().from(transactionsTable).where(eq(transactionsTable.id, id)))[0]!;
const decisionsOf = async (id: string) =>
  db.select().from(categoryDecisionsTable).where(eq(categoryDecisionsTable.transactionId, id)).orderBy(categoryDecisionsTable.createdAt);
/** The merchants the scripted model was asked about, across every call so far. */
const askedAbout = () =>
  fakeCalls.flatMap((c) => (JSON.parse(c.messages[0]!.content as string).charges as Array<{ merchant: string }>).map((x) => x.merchant));

async function views() {
  const week = (await api("GET", `/money/period-breakdown?period=week&start=${WEEK.start}`)).json;
  const amex = (await api("GET", `/amex/summary?accountId=${CARD}&from=${WEEK.start}&to=${TODAY}`)).json;
  const spine = (await api("GET", "/spine")).json;
  const count = (await api("GET", "/categorization/review/count")).json;
  const byCat = Object.fromEntries((week.categories as Array<{ name: string; amount: string; count: number }>).map((c) => [c.name, [c.amount, c.count]]));
  const amexRow = (id: string) =>
    [...amex.needsAttention.unplanned.rows, ...amex.needsAttention.unfiled.rows, ...amex.needsAttention.uncategorized.rows].find((r: { id: string }) => r.id === id) ?? null;
  return { week, amex, spine, reviewTotal: count.total as number, byCat, amexRow, uncategorized: amex.needsAttention.uncategorized };
}

let emitted: CategorizeJobData;
let runBody: any;

beforeAll(async () => {
  HH = (await createTestHousehold(OWNER)).householdId;
  HOUSEHOLDS[OWNER] = HH;
  invalidateTaskConfigCache();
  const mk = async (key: string, name: string, kind = "expense") => {
    const [c] = await db.insert(budgetCategoriesTable).values({ userId: OWNER, householdId: HH, name, kind, groupName: "Synthetic" }).returning();
    cat[key] = c!.id;
  };
  await mk("groceries", "Synth Groceries");
  await mk("dining", "Synth Dining");
  await mk("coffee", "Synth Coffee");
  await mk("home", "Synth Home");
  await mk("pay", "Synth Pay", "income");
  await seedCard(HH, OWNER, CARD);
  await db.insert(mappingRulesTable).values({ userId: OWNER, householdId: HH, pattern: "SYNTH RULE", matchType: "contains", categoryId: cat.dining!, priority: 0 });
  row.accept = await addCardRow(HH, OWNER, CARD, "SYNTH GROCER 01", "-42.00");
  row.skip = await addCardRow(HH, OWNER, CARD, "SYNTH CAFE 02", "-8.00");
  row.locked = await addCardRow(HH, OWNER, CARD, "SYNTH LOCKED 03", "-15.00", { categoryId: cat.dining!, categoryLockedByUser: true });
  row.rule = await addCardRow(HH, OWNER, CARD, "SYNTH RULE 04", "-20.00");
  row.typed = await addCardRow(HH, OWNER, CARD, "SYNTH TYPED 05", "-11.00", { categoryId: cat.groceries! });
  row.provisional = await addCardRow(HH, OWNER, CARD, "SYNTH HOME 06", "-30.00");
  // (index.ts) Production registers the categorizer's review count for the recap.
  registerCategorizationReviewCount(async (householdId) => (await listReviewQueue(householdId, 1)).total);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  registerCategorizationReviewCount(null);
  resetFake();
  await new Promise<void>((r) => server.close(() => r()));
  const { householdsTable } = await import("@workspace/db");
  for (const h of Object.values(HOUSEHOLDS)) {
    await db.delete(transactionsTable).where(eq(transactionsTable.householdId, h));
    await db.delete(householdsTable).where(eq(householdsTable.id, h));
  }
});

// The scripted model's answers (synthetic): what it WOULD say about every row,
// including the ones it must never be asked about.
const ANSWERS = () =>
  fixtureBy([
    ["SYNTH GROCER", { cat: cat.groceries!, confidence: "low", rationale: "Looks like a grocery shop." }],
    ["SYNTH CAFE", { cat: cat.coffee!, confidence: "low", rationale: "Looks like a coffee stop." }],
    ["SYNTH HOME", { cat: cat.home!, confidence: "medium", rationale: "Looks like a home store." }],
    ["SYNTH LOCKED", { cat: cat.home!, confidence: "high" }],
    ["SYNTH TYPED", { cat: cat.home!, confidence: "high" }],
    ["SYNTH RULE", { cat: cat.home!, confidence: "high" }],
  ]);

describe("categorization with a scripted model (fixture / provider-mocked verification)", () => {
  let before: Record<string, Awaited<ReturnType<typeof txn>>> = {};

  it("1. POST /categorization/run files the rule row and queues the model pass for the rest", async () => {
    resetFake();
    _emittedForTests.length = 0;
    for (const [k, id] of Object.entries(row)) before[k] = await txn(id);
    const res = await api("POST", "/categorization/run", {});
    expect(res.status).toBe(200);
    runBody = res.json;
    expect(runBody).toMatchObject({ decided: 1, filed: 1, modelQueued: 3, ambiguous: 3 });
    // The rule filed its row at once (auto); the model was not called inline.
    expect(fakeCalls).toHaveLength(0);
    expect(await txn(row.rule!)).toMatchObject({ categoryId: cat.dining, categoryProvisional: false, categoryLockedByUser: false });
    const [ruleDecision] = await decisionsOf(row.rule!);
    expect(ruleDecision).toMatchObject({ source: "rule", band: "auto", confidence: "0.950", categoryId: cat.dining });
    const jobs = _emittedForTests.filter((e) => e.queue === QUEUES.categorizeBatch);
    expect(jobs).toHaveLength(1);
    emitted = jobs[0]!.data as CategorizeJobData;
    expect(new Set(emitted.txnIds)).toEqual(new Set([row.accept, row.skip, row.provisional]));
  });

  it("2. the job asks the scripted model; a valid suggestion lands in GET /categorization/review", async () => {
    scriptCategorizer("suggestion", { answer: ANSWERS() });
    const out = await runCategorizeJob(emitted, { jobId: `job-${RUN}` });
    expect(out).toMatchObject({ status: "succeeded", filed: 1, waiting: 2, actions: 3 });
    // One call, about exactly the three rows no deterministic stage decided.
    expect(fakeCalls).toHaveLength(1);
    const asked = askedAbout().join(" | ");
    for (const d of ["SYNTH GROCER 01", "SYNTH CAFE 02", "SYNTH HOME 06"]) expect(asked).toContain(d);
    for (const d of ["SYNTH LOCKED 03", "SYNTH TYPED 05", "SYNTH RULE 04"]) expect(asked).not.toContain(d);
    // Low confidence = a question (nothing written); medium = provisional (written, flagged).
    expect(await txn(row.accept!)).toMatchObject({ categoryId: null, categoryProvisional: false });
    expect(await txn(row.skip!)).toMatchObject({ categoryId: null, categoryProvisional: false });
    expect(await txn(row.provisional!)).toMatchObject({ categoryId: cat.home, categoryProvisional: true, categoryLockedByUser: false });
    const q = await api("GET", "/categorization/review?limit=20");
    expect(q.status).toBe(200);
    const items = q.json.items as Array<{ transactionId: string; suggestedCategoryId: string; band: string; source: string; explanation: string }>;
    const byTxn = new Map(items.map((i) => [i.transactionId, i]));
    expect(byTxn.get(row.accept!)).toMatchObject({ suggestedCategoryId: cat.groceries, band: "queue", source: "model", explanation: "Looks like a grocery shop." });
    expect(byTxn.get(row.skip!)).toMatchObject({ suggestedCategoryId: cat.coffee, band: "queue", source: "model" });
    expect(byTxn.get(row.provisional!)).toMatchObject({ suggestedCategoryId: cat.home, band: "provisional", source: "model" });
    expect(q.json.total).toBe(3);
    expect((await api("GET", "/categorization/review/count")).json).toEqual({ total: 3 });
    // The run is on the trail: succeeded, its summary in words.
    const [run] = await db.select().from(agentRunsTable).where(and(eq(agentRunsTable.householdId, HH), eq(agentRunsTable.kind, "categorize")));
    expect(run).toMatchObject({ status: "succeeded", summary: "Filed 1 charge, 2 waiting for you." });
  });

  describe("3. the morning recap through the real routes, console transport only", () => {
    it("its figures are the spine's, and its review count is the queue's", async () => {
      const prev = await api("POST", "/recap/preview", {});
      expect(prev.status).toBe(200);
      const facts = prev.json.facts;
      const spine = (await api("GET", "/spine")).json;
      const count = (await api("GET", "/categorization/review/count")).json.total;
      expect(facts.position).toMatchObject({
        safeToSpendNow: spine.position.safeToSpendNow === null ? null : Number(spine.position.safeToSpendNow),
        availableUntilPayday: spine.position.availableUntilPayday === null ? null : Number(spine.position.availableUntilPayday),
        paydayDate: spine.position.paydayDate,
        horizonKind: spine.position.horizonKind,
        confidence: spine.position.confidence,
        degraded: spine.position.degraded,
      });
      expect(facts.weekToDate.withinPlan).toBe(spine.position.withinPlan);
      // The week's spending it reads = the spine's "Counts toward plan" + "Unconfirmed", to the cent.
      const cents = (v: string | number) => Math.round(Number(v) * 100);
      expect(cents(facts.weekToDate.spent)).toBe(cents(spine.position.knownWeek) + cents(spine.position.unresolvedWeek));
      expect(cents(facts.weekToDate.spent)).toBeGreaterThan(0);
      expect(facts.weekToDate.remainingWeek).toBe(spine.position.remainingWeek === null ? null : Number(spine.position.remainingWeek));
      expect(facts.reviewCount).toBe(spine.reviewCount);
      expect(facts.categorizationReviewCount).toBe(count);
      expect(count).toBe(3);
      expect(facts.needsLookCount).toBe(spine.reviewCount + count);
      // The template (what is sent when the model is off) says the same count.
      const n = facts.needsLookCount;
      expect(prev.json.template.text).toContain(`${n} ${n === 1 ? "charge needs" : "charges need"} a look.`);
      // The demo model draft is labelled as such (no model was called).
      expect(prev.json.model).toMatchObject({ demo: true });
      // The recap does not quote Checking today, the week's counted/unconfirmed split or the low point.
      for (const k of ["bank", "knownWeek", "unresolvedWeek", "lowPoint", "lowPointDate"]) {
        expect(JSON.stringify(facts)).not.toContain(`"${k}"`);
      }
    });

    it("generate + the scheduled send go out through the console provider: previewed, nothing sent", async () => {
      expect(getSmsProvider().name).toBe("console");
      expect(getSmsConfig()).toEqual({ provider: "console", configured: false, mode: "preview" });
      // A verified synthetic number (555-01xx is reserved for fiction); the preview above created the row.
      const on = { enabled: true, phoneE164: "+15555550123", verifiedAt: new Date(), consentedAt: new Date(), timezone: "America/Chicago" };
      await db
        .insert(recapSettingsTable)
        .values({ householdId: HH, userId: OWNER, ...on })
        .onConflictDoUpdate({ target: [recapSettingsTable.householdId, recapSettingsTable.userId], set: on });
      // The template, as the morning text is sent when the model is off.
      process.env.AI_ENABLED = "false";
      let gen;
      try {
        gen = await api("POST", "/recap/generate-now", {});
      } finally {
        process.env.AI_ENABLED = "true";
      }
      expect(gen.status).toBe(200);
      expect(gen.json.recap).toMatchObject({ source: "template", status: "drafted", delivery: null });
      const preview = (await api("POST", "/recap/preview", {})).json;
      expect(gen.json.recap.text).toBe(preview.template.text);
      const forDate = gen.json.recap.forDate as string;
      const outcome = await sendScheduledRecap({ householdId: HH, userId: OWNER, forDate });
      expect(outcome).toBe("sent");
      const deliveries = await db.select().from(recapDeliveriesTable).where(eq(recapDeliveriesTable.userId, OWNER));
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({ provider: "console", kind: "scheduled", forDate });
      expect(sentSms).toHaveLength(0);
      const hist = (await api("GET", "/recap/history")).json;
      expect(hist[0]).toMatchObject({ forDate, status: "previewed", delivery: { provider: "console", status: "previewed" } });
      const settings = (await api("GET", "/recap/settings")).json;
      expect(settings.delivery).toMatchObject({ mode: "preview", providerConfigured: false, lastDelivery: { provider: "console", status: "previewed" } });
      await db.delete(recapDeliveriesTable).where(eq(recapDeliveriesTable.userId, OWNER));
      await db.delete(recapsTable).where(eq(recapsTable.userId, OWNER));
    });
  });

  let pre: Awaited<ReturnType<typeof views>>;
  let acceptRes: any;
  let acceptRowBefore: Awaited<ReturnType<typeof txn>>;

  it("4a. Accept files the row: locked, not provisional; the week breakdown, the Amex summary and the count move", async () => {
    pre = await views();
    acceptRowBefore = await txn(row.accept!);
    const [d] = (await decisionsOf(row.accept!)).filter((x) => x.source === "model");
    acceptRes = await api("POST", `/categorization/review/${d!.id}/accept`, {});
    expect(acceptRes.status).toBe(200);
    expect(acceptRes.json).toMatchObject({ resolution: "accepted", categoryId: cat.groceries, transactionId: row.accept });
    expect(acceptRes.json.userDecisionId).toBeTruthy();
    expect(await txn(row.accept!)).toMatchObject({ categoryId: cat.groceries, categoryLockedByUser: true, categoryProvisional: false });
    const post = await views();
    // Synth Groceries had the typed 11.00 row; now 11.00 + 42.00.
    expect(pre.byCat["Synth Groceries"]).toEqual(["11.00", 1]);
    expect(post.byCat["Synth Groceries"]).toEqual(["53.00", 2]);
    expect(Number(post.week.actual)).toBeCloseTo(Number(pre.week.actual), 2); // the week's total is the same money
    // Amex summary: the row was in "uncategorized" (no category); filed, it leaves that list and the tally drops by 42.00.
    expect(pre.amexRow(row.accept!)).toMatchObject({ category: null, flags: ["weekly", "uncategorized"], amount: "42.00" });
    expect(pre.uncategorized.rows.map((r: { id: string }) => r.id)).toContain(row.accept);
    expect(post.amexRow(row.accept!)).toBeNull();
    expect(post.uncategorized.rows.map((r: { id: string }) => r.id)).not.toContain(row.accept);
    expect(Number(pre.uncategorized.amount) - Number(post.uncategorized.amount)).toBeCloseTo(42, 2);
    expect(post.uncategorized.count).toBe(pre.uncategorized.count - 1);
    expect(post.reviewTotal).toBe(pre.reviewTotal - 1);
    // The spine's review count is the bank-matching count: categorizing a card row does not move it.
    expect(post.spine.reviewCount).toBe(pre.spine.reviewCount);
  });

  it("4b. Skip (reject) leaves the row exactly as it was and records the answer", async () => {
    const rowBefore = await txn(row.skip!);
    const [d] = (await decisionsOf(row.skip!)).filter((x) => x.source === "model");
    const res = await api("POST", `/categorization/review/${d!.id}/skip`, {});
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ resolution: "skipped", userDecisionId: null });
    expect(await txn(row.skip!)).toEqual(rowBefore);
    const [after] = (await decisionsOf(row.skip!)).filter((x) => x.source === "model");
    expect(after).toMatchObject({ resolution: "skipped", resolvedBy: OWNER, resolvedVia: "user", undoneAt: null });
    expect(after!.resolvedAt).not.toBeNull();
    expect((await api("GET", "/categorization/review/count")).json.total).toBe(1);
    // Answering twice is refused.
    expect((await api("POST", `/categorization/review/${d!.id}/skip`, {})).status).toBe(409);
  });

  it("4c. Accepting a provisional suggestion keeps its category and makes it the person's (locked)", async () => {
    const [d] = (await decisionsOf(row.provisional!)).filter((x) => x.source === "model");
    const res = await api("POST", `/categorization/review/${d!.id}/accept`, {});
    expect(res.status).toBe(200);
    expect(await txn(row.provisional!)).toMatchObject({ categoryId: cat.home, categoryLockedByUser: true, categoryProvisional: false });
    expect((await api("GET", "/categorization/review/count")).json.total).toBe(0);
  });

  it("4d. Undo (/category-decisions/:id/undo) puts the accepted row back exactly, and the views with it", async () => {
    const mid = await views();
    const res = await api("POST", `/category-decisions/${acceptRes.json.userDecisionId}/undo`, {});
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ transactionId: row.accept, categoryId: null });
    expect(await txn(row.accept!)).toEqual(acceptRowBefore);
    const back = await views();
    expect(back.byCat["Synth Groceries"]).toEqual(pre.byCat["Synth Groceries"]);
    expect(back.amexRow(row.accept!)).toEqual(pre.amexRow(row.accept!));
    expect(back.uncategorized.amount).toBe(pre.uncategorized.amount);
    expect(back.uncategorized.count).toBe(pre.uncategorized.count);
    // Observed: the undone row is unfiled again but is NOT put back in the review queue
    // (the model's suggestion stays answered); the count is what it was after 4c.
    expect(back.reviewTotal).toBe(mid.reviewTotal);
    // A second undo is refused.
    expect((await api("POST", `/category-decisions/${acceptRes.json.userDecisionId}/undo`, {})).status).toBe(409);
  });

  it("5. a locked row, a typed category and a rule-filed row never moved, and the model was never asked about them", async () => {
    expect(await txn(row.locked!)).toEqual(before.locked);
    expect(await txn(row.typed!)).toEqual(before.typed);
    expect(await decisionsOf(row.locked!)).toHaveLength(0);
    expect(await decisionsOf(row.typed!)).toHaveLength(0);
    // The rule row: one decision, the rule's, never a model one.
    expect((await decisionsOf(row.rule!)).map((d) => d.source)).toEqual(["rule"]);
    // Run the whole thing again: nothing new is decided, nothing moves.
    _emittedForTests.length = 0;
    const again = await api("POST", "/categorization/run", {});
    expect(again.json).toMatchObject({ decided: 0, filed: 0 });
    for (const k of ["locked", "typed", "rule"]) expect((await txn(row[k]!)).categoryId).toBe(before[k]!.categoryId ?? cat.dining);
    // A user decision outranks the model even when the job runs again over the row.
    scriptCategorizer("suggestion", { answer: ANSWERS() });
    fakeCalls.length = 0;
    await runCategorizeJob({ householdId: HH, ownerUserId: OWNER, txnIds: [row.locked!, row.typed!, row.rule!, row.provisional!], trigger: "user" });
    const asked = askedAbout().join(" | ");
    for (const d of ["SYNTH LOCKED 03", "SYNTH TYPED 05", "SYNTH RULE 04", "SYNTH HOME 06"]) expect(asked).not.toContain(d);
    expect(await txn(row.provisional!)).toMatchObject({ categoryId: cat.home, categoryLockedByUser: true });
  });
});

describe("6. each failure kind: rows unchanged, the failure recorded, one call and stop (fixture / provider-mocked)", () => {
  // 25 rows = two model batches (20 + 5): a stop-worthy failure must not try the second.
  const cases: Array<{
    kind: Exclude<ScriptedKind, "suggestion">;
    throws: boolean;
    status: string;
    error: string | null;
    usage: string;
    calls: number;
    summary: RegExp;
  }> = [
    { kind: "empty", throws: false, status: "succeeded", error: null, usage: "ok", calls: 2, summary: /^Filed 0 charges, 25 waiting for you\.$/ },
    { kind: "malformed", throws: false, status: "failed", error: "parse_failed", usage: "parse_failed", calls: 4, summary: /^Could not read the categorizer's answer\. 25 charges waiting for you\.$/ },
    { kind: "timeout", throws: true, status: "failed", error: "timeout", usage: "timeout", calls: 1, summary: /^Could not reach the categorizer\. 25 charges waiting for you\.$/ },
    { kind: "api_error", throws: true, status: "failed", error: "api_error", usage: "api_error", calls: 1, summary: /^Could not reach the categorizer\. 25 charges waiting for you\.$/ },
    { kind: "rate_limited", throws: true, status: "failed", error: "rate_limited", usage: "rate_limited", calls: 1, summary: /^Could not reach the categorizer\. 25 charges waiting for you\.$/ },
  ];

  beforeEach(() => resetFake());

  for (const c of cases) {
    it(`${c.kind}: rows unchanged; run ${c.status}${c.error ? ` (${c.error})` : ""}; ${c.calls} provider call(s); ${c.throws ? "throws for a bounded pg-boss retry" : "no retry"}`, async () => {
      const owner = `${OWNER}-${c.kind}`;
      const hh = (await createTestHousehold(owner)).householdId;
      HOUSEHOLDS[owner] = hh;
      const acct = `v-cat-fail-${c.kind}-${RUN}`;
      await seedCard(hh, owner, acct);
      const [g] = await db.insert(budgetCategoriesTable).values({ userId: owner, householdId: hh, name: "Synth Groceries", kind: "expense", groupName: "Synthetic" }).returning();
      const ids: string[] = [];
      for (let i = 0; i < 25; i++) ids.push(await addCardRow(hh, owner, acct, `SYNTH FAIL ${c.kind.toUpperCase()} ${String(i).padStart(2, "0")}`, `-${(5 + i).toFixed(2)}`));
      const rowsBefore = await db.select().from(transactionsTable).where(inArray(transactionsTable.id, ids));
      if (c.kind === "empty") scriptCategorizer("empty");
      else scriptCategorizer(c.kind);
      const go = runCategorizeJob({ householdId: hh, ownerUserId: owner, txnIds: ids, trigger: "user" }, { jobId: `job-${c.kind}-${RUN}` });
      if (c.throws) await expect(go).rejects.toThrow(`categorize: ${c.kind}`);
      else await expect(go).resolves.toMatchObject({ status: c.status, filed: 0, waiting: 25 });
      // Every row exactly as it was.
      const rowsAfter = await db.select().from(transactionsTable).where(inArray(transactionsTable.id, ids));
      expect(byIdSort(rowsAfter)).toEqual(byIdSort(rowsBefore));
      expect(await db.select().from(categoryDecisionsTable).where(eq(categoryDecisionsTable.householdId, hh))).toHaveLength(0);
      // The failure is recorded on the run (no silent success) …
      const runs = await db.select().from(agentRunsTable).where(eq(agentRunsTable.householdId, hh));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ kind: "categorize", status: c.status, error: c.error });
      expect(runs[0]!.summary).toMatch(c.summary);
      expect(runs[0]!.finishedAt).not.toBeNull();
      // … and in the usage ledger, one row per provider call.
      const usage = await db.select().from(aiUsageTable).where(eq(aiUsageTable.householdId, hh));
      expect(usage).toHaveLength(c.calls);
      expect(new Set(usage.map((u) => u.status))).toEqual(new Set([c.usage]));
      // No storm: a stop-worthy failure ends the run after one call.
      expect(fakeCalls).toHaveLength(c.calls);
      // The suggestion's category was never written anywhere.
      expect(rowsAfter.some((r) => r.categoryId === g!.id)).toBe(false);
    });
  }

  it("a retried job (pg-boss, at most 3 retries, one job per household a minute) reuses its run and asks once per attempt", async () => {
    expect(categorizeSendOptions("hh")).toMatchObject({ retryLimit: 3, singletonSeconds: 60, singletonKey: "cat:hh" });
    const owner = `${OWNER}-retry`;
    const hh = (await createTestHousehold(owner)).householdId;
    HOUSEHOLDS[owner] = hh;
    const acct = `v-cat-retry-${RUN}`;
    await seedCard(hh, owner, acct);
    await db.insert(budgetCategoriesTable).values({ userId: owner, householdId: hh, name: "Synth Groceries", kind: "expense", groupName: "Synthetic" });
    const ids = [await addCardRow(hh, owner, acct, "SYNTH RETRY 01", "-9.00")];
    scriptCategorizer("timeout", { times: 3 });
    const jobId = `job-retry-${RUN}`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await expect(runCategorizeJob({ householdId: hh, ownerUserId: owner, txnIds: ids }, { jobId })).rejects.toThrow("categorize: timeout");
      expect(fakeCalls).toHaveLength(attempt);
    }
    const runs = await db.select().from(agentRunsTable).where(eq(agentRunsTable.householdId, hh));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "failed", error: "timeout" });
    expect((await txn(ids[0]!)).categoryId).toBeNull();
  });
});

const byIdSort = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
