// (AI-2) runAgent on the scripted fake tool loop: the run row, the ledger, the
// persisted turns, the grounding check, and every way a run can end.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { asc, eq } from "drizzle-orm";
import { db, agentConversationsTable, agentMessagesTable, agentRunsTable, aiBudgetTable, aiUsageTable } from "@workspace/db";
import { runAgent, loadHistory, HISTORY_MESSAGES, MESSAGE_CHAR_CAP, type AiChatEvent } from "../ai/agent/runAgent";
import { UNVERIFIED_LINE, checkGrounding, collectFigures } from "../ai/agent/grounding";
import { fakeToolLoops, queueFakeChat, resetFake } from "../ai/fake";
import { invalidateTaskConfigCache } from "../ai/config";
import { daysAgo } from "./_helpers/aiCategorize";
import { pinEnv } from "./_helpers/aiEnv";
import { seedAskHousehold, type AskHousehold } from "./_helpers/askFixtures";

pinEnv({ AI_PROVIDER: "fake", AI_ENABLED: "true", AI_PAUSED: undefined, AI_MODEL_CHAT: undefined });

let H: AskHousehold;
const FROM = daysAgo(20);
const TO = daysAgo(0);

async function conversation(): Promise<string> {
  const [c] = await db.insert(agentConversationsTable).values({ householdId: H.householdId, userId: H.owner }).returning({ id: agentConversationsTable.id });
  return c!.id;
}
async function ask(conversationId: string, userText: string, extra: { userAskedToChange?: boolean } = {}) {
  const events: AiChatEvent[] = [];
  const result = await runAgent({
    ctx: { householdId: H.householdId, ownerUserId: H.owner, actorUserId: H.owner },
    conversationId,
    userText,
    onEvent: (e) => events.push(e),
    ...extra,
  });
  return { result, events };
}
const run = async (id: string) => (await db.select().from(agentRunsTable).where(eq(agentRunsTable.id, id)))[0]!;
const usage = (runId: string) => db.select().from(aiUsageTable).where(eq(aiUsageTable.runId, runId)).orderBy(asc(aiUsageTable.createdAt));
const messages = (cid: string) => db.select().from(agentMessagesTable).where(eq(agentMessagesTable.conversationId, cid)).orderBy(asc(agentMessagesTable.createdAt), asc(agentMessagesTable.id));

beforeAll(async () => {
  H = await seedAskHousehold("agent", { merchant: "AGENTCO" });
});
beforeEach(async () => {
  resetFake();
  invalidateTaskConfigCache();
  await db.delete(aiBudgetTable).where(eq(aiBudgetTable.householdId, H.householdId));
});

describe("a grounded answer", () => {
  it("calls a tool, answers with its figure, and leaves a complete trail", async () => {
    queueFakeChat({
      calls: [{ name: "get_spending_summary", input: { from: FROM, to: TO } }],
      text: (results) => {
        const spent = JSON.parse(results[0]!).spent as number;
        return `You spent $${spent.toLocaleString("en-US", { minimumFractionDigits: 2 })} in that stretch.\nBased on: ref:${H.txns.kroger}`;
      },
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    const cid = await conversation();
    const { result, events } = await ask(cid, "How much did we spend lately?");
    expect(result.status).toBe("succeeded");
    expect(result.grounded).toBe(true);
    expect(result.text).toContain("$111.70");
    expect(result.text).not.toContain(UNVERIFIED_LINE);

    expect(events.map((e) => e.type)).toEqual(["tool", "tool", ...Array(events.filter((e) => e.type === "token").length).fill("token"), "done"]);
    expect(events[0]).toEqual({ type: "tool", name: "get_spending_summary", status: "running" });
    expect(events[1]).toEqual({ type: "tool", name: "get_spending_summary", status: "done" });
    const done = events.at(-1) as Extract<AiChatEvent, { type: "done" }>;
    expect(done).toMatchObject({ runId: result.runId, messageId: result.messageId, grounded: true, demo: true });

    const r = await run(result.runId);
    expect(r).toMatchObject({ kind: "chat", trigger: "user", status: "succeeded", conversationId: cid });
    expect(r.finishedAt).not.toBeNull();
    expect(r.summary).toContain("1 tool calls (get_spending_summary)");
    expect(r.summary).toContain("figures verified");
    const u = await usage(result.runId);
    expect(u).toHaveLength(2); // one request for the tool turn, one for the answer
    expect(u.every((x) => x.task === "chat" && x.promptVersion === "chat.v1" && x.status === "ok")).toBe(true);
    expect(r.inputTokens).toBe(200);
    expect(r.outputTokens).toBe(40);

    const m = await messages(cid);
    expect(m.map((x) => x.role)).toEqual(["user", "tool", "assistant"]);
    expect((m[1]!.content as { name: string }).name).toBe("get_spending_summary");
    expect(m[2]!.content).toMatchObject({ grounded: true, demo: true });
  });

  it("accepts a figure the person's own message gave", async () => {
    queueFakeChat({ text: "A $50 treat fits inside that." });
    const { result } = await ask(await conversation(), "Can we afford a $50 treat?");
    expect(result.grounded).toBe(true);
  });
});

describe("an invented figure", () => {
  it("keeps the answer, appends the caveat, and marks the run", async () => {
    queueFakeChat({
      calls: [{ name: "get_spending_summary", input: { from: FROM, to: TO } }],
      text: "You spent $777.77 on pets.",
    });
    const cid = await conversation();
    const { result, events } = await ask(cid, "What did we spend?");
    expect(result.status).toBe("succeeded");
    expect(result.grounded).toBe(false);
    expect(result.text).toBe(`You spent $777.77 on pets.\n\n${UNVERIFIED_LINE}`);
    expect((await run(result.runId)).summary).toContain("1 figures could not be verified");
    expect((events.at(-1) as { text: string }).text).toContain(UNVERIFIED_LINE);
    const last = (await messages(cid)).at(-1)!;
    expect(last.content).toMatchObject({ grounded: false });
  });

  it("checkGrounding reads both $1,234 and $1,234.56, and ignores ids, dates and outside text", () => {
    const known = collectFigures([
      JSON.stringify({ spent: 1234.56, id: "3f9a1c07-aaaa-4bbb-8ccc-123456789012", date: "2026-10-07", note: '<untrusted source="m">STORE 9999</untrusted>', n: 40 }),
    ]);
    expect(checkGrounding("You spent $1,234.56.", known).ok).toBe(true);
    expect(checkGrounding("About $1,235 or $1,234.", known).ok).toBe(true); // whole-dollar readings (round, floor)
    expect(checkGrounding("$1,300 and $40", known)).toEqual({ ok: false, ungrounded: ["$1,300"] });
    expect(checkGrounding("$9999 and $2026 and $07 and $12345", known).ungrounded).toEqual(["$9999", "$2026", "$07", "$12345"]);
    expect(checkGrounding("$1,234.50", known).ok).toBe(false);
    expect(checkGrounding("No money here, just 3 things.", known).ok).toBe(true);
  });
});

describe("how a run ends", () => {
  it("is off when AI is off", async () => {
    process.env.AI_ENABLED = "false";
    try {
      const { result, events } = await ask(await conversation(), "hi");
      expect(result).toMatchObject({ status: "failed", errorCode: "disabled" });
      expect(events.at(-1)).toMatchObject({ type: "error", code: "disabled", retryable: false });
    } finally {
      process.env.AI_ENABLED = "true";
    }
  });

  it("is blocked by the budget, and the block is a zero-cost ledger row", async () => {
    await db.insert(aiBudgetTable).values({ householdId: H.householdId, pausedUntil: new Date(Date.now() + 3_600_000) });
    const { result, events } = await ask(await conversation(), "hi");
    expect(result).toMatchObject({ status: "budget_exceeded", errorCode: "budget_exceeded" });
    expect(events.at(-1)).toMatchObject({ type: "error", code: "budget_exceeded" });
    const u = await usage(result.runId);
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({ status: "budget_exceeded", task: "chat" });
    expect(Number(u[0]!.costUsd)).toBe(0);
    expect(fakeToolLoops).toHaveLength(0);
  });

  it("a refusal is a refused run with no answer stored", async () => {
    queueFakeChat({ text: "", stopReason: "refusal" });
    const cid = await conversation();
    const { result } = await ask(cid, "hi");
    expect(result).toMatchObject({ status: "refused", errorCode: "refusal" });
    expect((await usage(result.runId)).at(-1)!.status).toBe("refusal");
    expect((await messages(cid)).map((m) => m.role)).toEqual(["user"]);
  });

  it("stops at the step cap and says so", async () => {
    queueFakeChat({ calls: Array.from({ length: 9 }, () => ({ name: "get_position", input: {} })), text: "never" });
    const { result } = await ask(await conversation(), "loop forever");
    expect(result).toMatchObject({ status: "failed", errorCode: "too_many_steps" });
    expect((await usage(result.runId))).toHaveLength(8);
  });

  it("a provider failure is a failed run with its failure on the ledger", async () => {
    queueFakeChat({ text: "", error: new Error("boom") });
    const { result, events } = await ask(await conversation(), "hi");
    expect(result).toMatchObject({ status: "failed", errorCode: "api_error" });
    expect(events.at(-1)).toMatchObject({ type: "error", code: "api_error" });
    expect((await usage(result.runId))[0]!.status).toBe("api_error");
  });

  it("a cut-off answer (max_tokens) is not shown as an answer", async () => {
    queueFakeChat({ text: "half an ans", stopReason: "max_tokens" });
    const { result } = await ask(await conversation(), "hi");
    expect(result).toMatchObject({ status: "failed", errorCode: "max_tokens" });
  });
});

describe("history", () => {
  it("sends the last 12 turns, starting on a question, with each cut to 4,000 characters", async () => {
    const cid = await conversation();
    const rows = [];
    for (let i = 0; i < 16; i++) {
      rows.push({ conversationId: cid, role: i % 2 === 0 ? "user" : "assistant", content: { text: i === 8 ? "z".repeat(9000) : `turn ${i}` }, createdAt: new Date(Date.now() - (20 - i) * 1000) });
    }
    await db.insert(agentMessagesTable).values(rows);
    const h = await loadHistory(cid);
    expect(h.length).toBeLessThanOrEqual(HISTORY_MESSAGES);
    expect(h[0]!.role).toBe("user");
    expect(h.some((x) => x.text.length === MESSAGE_CHAR_CAP)).toBe(true);
    expect(h.every((x) => x.text.length <= MESSAGE_CHAR_CAP)).toBe(true);

    queueFakeChat({ text: "ok" });
    await ask(cid, "and now?");
    const sent = fakeToolLoops.at(-1)!.messages;
    expect(sent.at(-1)).toEqual({ role: "user", content: "and now?" });
    expect(sent.filter((m) => m.content === "and now?")).toHaveLength(1);
    expect(sent.length).toBeLessThanOrEqual(HISTORY_MESSAGES + 1);
  });

  it("stops at 6,000 tokens, oldest first, and the system text carries no per-call values", async () => {
    const cid = await conversation();
    await db.insert(agentMessagesTable).values(
      Array.from({ length: 12 }, (_, i) => ({ conversationId: cid, role: i % 2 === 0 ? "user" : "assistant", content: { text: "w".repeat(3900) }, createdAt: new Date(Date.now() - (30 - i) * 1000) })),
    );
    const h = await loadHistory(cid);
    expect(h.reduce((a, x) => a + Math.ceil(x.text.length / 4), 0)).toBeLessThanOrEqual(6000);
    queueFakeChat({ text: "ok" });
    await ask(cid, "q");
    const sys = fakeToolLoops.at(-1)!.system;
    expect(sys).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(sys).not.toContain(H.householdId);
    expect(sys).toContain("untrusted");
  });
});
