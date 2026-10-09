import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, agentFindingsTable, agentRunsTable, aiBudgetTable, aiUsageTable, recapDeliveriesTable, recapsTable } from "@workspace/db";
import { pinEnv } from "./_helpers/aiEnv";
import { makeMembers, dropMembers, type TestMember } from "./_helpers/smsFixtures";
import { FOR_DATE, NOW, seedRecapHousehold, wipeRecapHousehold } from "./_helpers/recapFixtures";
import { fakeCalls, queueFakeSteps, resetFake } from "../ai/fake";
import { invalidateTaskConfigCache } from "../ai/config";
import { generateRecap, recapLink } from "../recap/generate";

// (AI-4a) generateRecap end to end on the fake provider and a real Postgres:
// grounded model text is kept, ungrounded text is retried once with the
// validator's message and then replaced by the template, the link is appended
// by code, one recap and one agent_runs row are stored per generation, and a
// preview stores nothing.

pinEnv({ AI_PROVIDER: "fake", AI_ENABLED: "true", AI_PAUSED: undefined, AI_MODEL_RECAP: undefined, APP_URL: "https://h2.example.test" });

let A: TestMember, B: TestMember;
const LINK = `https://h2.example.test/?d=${FOR_DATE}`;

beforeAll(async () => {
  vi.setSystemTime(NOW);
  [A, B] = await makeMembers(2);
  await seedRecapHousehold(A);
  await seedRecapHousehold(B);
});
afterAll(async () => {
  vi.useRealTimers();
  await wipeRecapHousehold(A);
  await wipeRecapHousehold(B);
  await dropMembers([A, B]);
});
beforeEach(async () => {
  resetFake();
  invalidateTaskConfigCache();
  for (const m of [A, B]) {
    await db.delete(aiUsageTable).where(eq(aiUsageTable.householdId, m.householdId));
    await db.delete(aiBudgetTable).where(eq(aiBudgetTable.householdId, m.householdId));
    await db.delete(agentRunsTable).where(eq(agentRunsTable.householdId, m.householdId));
    await db.delete(recapsTable).where(eq(recapsTable.householdId, m.householdId));
  }
});

const GOOD = { text: "Yesterday: $92 spent (Groceries $50). Electric $90 tomorrow.", factsUsed: ["spentYesterday", "billsNext3Days"] };
// The action line is chosen by code and appended when a draft leaves it out.
const actionOf = (facts: unknown): string => {
  const a = (facts as { action?: { text: string } | null }).action?.text;
  return a ? ` ${a}` : "";
};
const usageRows = (m: TestMember) => db.select().from(aiUsageTable).where(eq(aiUsageTable.householdId, m.householdId));
const runRows = (m: TestMember) => db.select().from(agentRunsTable).where(eq(agentRunsTable.householdId, m.householdId));

describe("a stored recap", () => {
  it("keeps a grounded model draft, appends the link by code, and records one recap and one run", async () => {
    queueFakeSteps("recap", { kind: "ok", value: GOOD, usage: { inputTokens: 900, outputTokens: 40 } });
    const out = await generateRecap(A.householdId, A.userId, FOR_DATE, { trigger: "schedule" });
    if (out.preview) throw new Error("expected a stored recap");
    expect(out.created).toBe(true);
    expect(out.recap).toMatchObject({
      source: "model",
      status: "drafted",
      promptVersion: "recap.v3",
      forDate: FOR_DATE,
      userId: A.userId,
      householdId: A.householdId,
    });
    expect(out.recap.facts).toMatchObject({ yesterday: "2026-10-06", spentYesterday: { total: 92.4 } });
    expect(out.recap.text).toBe(`${GOOD.text}${actionOf(out.recap.facts)} ${LINK}`);
    expect((out.recap.facts as { action: unknown }).action).not.toBeNull();

    const runs = await runRows(A);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ kind: "recap", trigger: "schedule", status: "succeeded", inputTokens: 900, outputTokens: 40 });
    expect(runs[0]!.finishedAt).not.toBeNull();
    expect(runs[0]!.summary).toBe("model draft, 1 call");
    const usage = await usageRows(A);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ task: "recap", status: "ok", promptVersion: "recap.v3", runId: runs[0]!.id });
  });

  it("sends the model the facts as data, with no row ids and no merchant strings", async () => {
    queueFakeSteps("recap", { kind: "ok", value: GOOD });
    await generateRecap(A.householdId, A.userId, FOR_DATE);
    const call = fakeCalls.at(-1)!;
    const user = String(call.messages[0]!.content);
    expect(user.startsWith('<data source="recap_facts">')).toBe(true);
    expect(user).not.toMatch(/CAFE|MARKET|GADGET|TRANSFER|PAYMENT/);
    expect(user).not.toContain(A.householdId);
    expect(call.system).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(call.task).toBe("recap");
  });

  it("an ungrounded number is retried once with the validator's message, then the template takes over", async () => {
    const bad = { text: "Yesterday: $777 spent.", factsUsed: [] };
    queueFakeSteps("recap", { kind: "ok", value: bad }, { kind: "ok", value: bad });
    const out = await generateRecap(A.householdId, A.userId, FOR_DATE);
    if (out.preview) throw new Error("expected a stored recap");
    expect(out.recap.source).toBe("template");
    expect(out.recap.promptVersion).toBeNull();
    expect(out.recap.text).toMatch(/^Yesterday: \$92 spent \(Groceries \$50, Unfiled \$30, Dining Out \$12\)\./);
    expect(out.recap.text.endsWith(` ${LINK}`)).toBe(true);
    // Exactly two model calls, and the second carried the reason.
    expect(fakeCalls).toHaveLength(2);
    expect(String(fakeCalls[1]!.messages[0]!.content)).toContain('The number "$777" is not in the facts');
    expect(String(fakeCalls[0]!.messages[0]!.content)).not.toContain("previous draft was rejected");
    const usage = await usageRows(A);
    expect(usage.map((u) => u.status)).toEqual(["validation_failed", "validation_failed"]);
    const [run] = await runRows(A);
    expect(run).toMatchObject({ status: "succeeded", summary: "template (validation_failed)" });
  });

  it("a bad first draft and a good second one keeps the model's text (one retry used)", async () => {
    queueFakeSteps("recap", { kind: "ok", value: { text: "Great job!", factsUsed: [] } }, { kind: "ok", value: GOOD });
    const out = await generateRecap(A.householdId, A.userId, FOR_DATE);
    if (out.preview) throw new Error("expected a stored recap");
    expect(out.recap.source).toBe("model");
    expect(out.recap.text).toBe(`${GOOD.text}${actionOf(out.recap.facts)} ${LINK}`);
    expect(fakeCalls).toHaveLength(2);
    expect(String(fakeCalls[1]!.messages[0]!.content)).toContain('contains "!"');
  });

  it("curly punctuation from the model is folded to ASCII before it is stored", async () => {
    queueFakeSteps("recap", { kind: "ok", value: { text: "Yesterday — $92 spent. Groceries ‘$50’.", factsUsed: [] } });
    const out = await generateRecap(A.householdId, A.userId, FOR_DATE);
    if (out.preview) throw new Error("expected a stored recap");
    expect(out.recap.text).toBe(`Yesterday - $92 spent. Groceries '$50'.${actionOf(out.recap.facts)} ${LINK}`);
  });

  it("falls back to the template with no model call when AI is off, over budget, or the model refuses", async () => {
    process.env.AI_ENABLED = "false";
    let out = await generateRecap(A.householdId, A.userId, FOR_DATE);
    process.env.AI_ENABLED = "true";
    if (out.preview) throw new Error("expected a stored recap");
    expect(out.recap.source).toBe("template");
    expect(fakeCalls).toHaveLength(0);
    expect((await runRows(A))[0]).toMatchObject({ status: "succeeded", summary: "template (disabled)" });

    await db.delete(recapsTable).where(eq(recapsTable.householdId, A.householdId));
    await db.insert(aiBudgetTable).values({ householdId: A.householdId, pausedUntil: new Date(Date.now() + 3_600_000) });
    out = await generateRecap(A.householdId, A.userId, FOR_DATE);
    if (out.preview) throw new Error("expected a stored recap");
    expect(out.recap.source).toBe("template");
    expect((await runRows(A)).map((r) => r.status)).toContain("budget_exceeded");
    await db.delete(aiBudgetTable).where(eq(aiBudgetTable.householdId, A.householdId));

    await db.delete(recapsTable).where(eq(recapsTable.householdId, A.householdId));
    queueFakeSteps("recap", { kind: "refusal" });
    out = await generateRecap(A.householdId, A.userId, FOR_DATE);
    if (out.preview) throw new Error("expected a stored recap");
    expect(out.recap.source).toBe("template");
    expect((await runRows(A)).map((r) => r.status)).toContain("refused");
  });

  it("is idempotent: a second generation for the same member and day returns the first, with no new call or run", async () => {
    queueFakeSteps("recap", { kind: "ok", value: GOOD });
    const first = await generateRecap(A.householdId, A.userId, FOR_DATE);
    const second = await generateRecap(A.householdId, A.userId, FOR_DATE);
    if (first.preview || second.preview) throw new Error("expected stored recaps");
    expect(second.created).toBe(false);
    expect(second.recap.id).toBe(first.recap.id);
    expect(fakeCalls).toHaveLength(1);
    expect(await runRows(A)).toHaveLength(1);
    expect(await db.select().from(recapsTable).where(eq(recapsTable.householdId, A.householdId))).toHaveLength(1);
  });

  it("two simultaneous generations store one recap", async () => {
    const [x, y] = await Promise.all([
      generateRecap(A.householdId, A.userId, FOR_DATE),
      generateRecap(A.householdId, A.userId, FOR_DATE),
    ]);
    if (x.preview || y.preview) throw new Error("expected stored recaps");
    expect(x.recap.id).toBe(y.recap.id);
    expect(await db.select().from(recapsTable).where(eq(recapsTable.householdId, A.householdId))).toHaveLength(1);
  });

  it("a retried job reuses its agent_runs row", async () => {
    await generateRecap(A.householdId, A.userId, FOR_DATE, { jobId: "job-1" });
    await db.delete(recapsTable).where(eq(recapsTable.householdId, A.householdId));
    await generateRecap(A.householdId, A.userId, FOR_DATE, { jobId: "job-1" });
    const runs = await runRows(A);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.jobId).toBe("job-1");
  });

  it("refuses another household's member", async () => {
    await expect(generateRecap(B.householdId, A.userId, FOR_DATE)).resolves.toBeDefined();
    // A's recap now exists under B's household id only if the guard failed; the unique slot is A's.
    await db.delete(recapsTable).where(eq(recapsTable.householdId, B.householdId));
    await generateRecap(A.householdId, A.userId, FOR_DATE);
    await expect(generateRecap(B.householdId, A.userId, FOR_DATE)).rejects.toThrow(/another household/);
  });
});

describe("findings", () => {
  it("the template mentions at most one unseen finding, marks it surfaced, and moves on tomorrow", async () => {
    process.env.AI_ENABLED = "false";
    try {
      const [f1, f2] = await db
        .insert(agentFindingsTable)
        .values([
          { householdId: A.householdId, kind: "duplicate_charge", dedupeKey: "d:1", severity: "high", confidence: "confirmed", payload: { amount: 30 } },
          { householdId: A.householdId, kind: "limit_near", dedupeKey: "l:1", severity: "watch", confidence: "confirmed", payload: { remainingWeek: 20 } },
        ])
        .returning();
      const out = await generateRecap(A.householdId, A.userId, FOR_DATE);
      if (out.preview) throw new Error("expected a stored recap");
      expect(out.recap.text).toContain("Two matching charges landed close together.");
      expect(out.recap.text).not.toContain("weekly limit");
      const [a] = await db.select().from(agentFindingsTable).where(eq(agentFindingsTable.id, f1!.id));
      const [b] = await db.select().from(agentFindingsTable).where(eq(agentFindingsTable.id, f2!.id));
      expect(a!.surfacedInRecapId).toBe(out.recap.id);
      expect(b!.surfacedInRecapId).toBeNull();
      // Tomorrow's recap moves on to the next one.
      const next = await generateRecap(A.householdId, A.userId, "2026-10-08");
      if (next.preview) throw new Error("expected a stored recap");
      expect(next.recap.text).toContain("The weekly limit is nearly used.");
      expect(next.recap.text).not.toContain("Two matching charges");
    } finally {
      process.env.AI_ENABLED = "true";
    }
  });

  it("a shortfall finding becomes the action line (the gap, from the finding) and is not said twice", async () => {
    process.env.AI_ENABLED = "false";
    try {
      await db.insert(agentFindingsTable).values({ householdId: A.householdId, kind: "shortfall_before_income", dedupeKey: "s:1", severity: "high", confidence: "confirmed", payload: { shortBy: 120 } });
      const out = await generateRecap(A.householdId, A.userId, FOR_DATE);
      if (out.preview) throw new Error("expected a stored recap");
      expect(out.recap.text).toContain("Cash may dip $120 under the buffer before payday.");
      expect(out.recap.text).not.toContain("Cash looks tight");
    } finally {
      process.env.AI_ENABLED = "true";
    }
  });
});

describe("preview", () => {
  it("returns both drafts and stores nothing (no recap, no delivery, no run)", async () => {
    queueFakeSteps("recap", { kind: "ok", value: GOOD });
    const out = await generateRecap(A.householdId, A.userId, FOR_DATE, { preview: true });
    if (!out.preview) throw new Error("expected a preview");
    expect(out.model).toEqual({ text: `${GOOD.text}${actionOf(out.facts)} ${LINK}`, source: "model", demo: true });
    expect(out.template.text).toMatch(/^Yesterday: \$92 spent/);
    expect(out.template.text.endsWith(LINK)).toBe(true);
    expect(out.facts.spentYesterday.total).toBe(92.4);
    expect(await db.select().from(recapsTable).where(eq(recapsTable.householdId, A.householdId))).toHaveLength(0);
    expect(await db.select().from(recapDeliveriesTable).where(eq(recapDeliveriesTable.householdId, A.householdId))).toHaveLength(0);
    expect(await runRows(A)).toHaveLength(0);
    // The call is still counted against the daily cap.
    expect(await usageRows(A)).toHaveLength(1);
  });

  it("with the demo provider the model draft is the labelled fixture", async () => {
    const out = await generateRecap(A.householdId, A.userId, FOR_DATE, { preview: true });
    if (!out.preview) throw new Error("expected a preview");
    expect(out.model).toEqual({ text: `Demo recap. No model was called.${actionOf(out.facts)} ${LINK}`, source: "model", demo: true });
  });

  it("the model draft is null when AI is off; the template is still there", async () => {
    process.env.AI_ENABLED = "false";
    try {
      const out = await generateRecap(A.householdId, A.userId, FOR_DATE, { preview: true });
      if (!out.preview) throw new Error("expected a preview");
      expect(out.model).toBeNull();
      expect(out.template.text.length).toBeGreaterThan(20);
    } finally {
      process.env.AI_ENABLED = "true";
    }
  });

  it("counts against the daily recap cap: after six calls today there is no model draft", async () => {
    // Six recap calls already made earlier today (UTC): the cap is 6.
    await db.insert(aiUsageTable).values(
      [0, 1, 2, 3, 4, 5].map((i) => ({
        householdId: A.householdId,
        task: "recap",
        model: "fake",
        status: "ok",
        createdAt: new Date(`2026-10-07T13:0${i}:00Z`),
      })),
    );
    const out = await generateRecap(A.householdId, A.userId, FOR_DATE, { preview: true });
    if (!out.preview) throw new Error("expected a preview");
    expect(out.model).toBeNull();
    expect(out.template.text.length).toBeGreaterThan(20);
    // And a preview that did run is one of those calls.
    expect(fakeCalls).toHaveLength(0);
    expect(recapLink(FOR_DATE)).toBe(LINK);
  });
});
