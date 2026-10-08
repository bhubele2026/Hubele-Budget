// (AI-1) PR-A's synthetic eval, with the MODEL stage in fake mode. This proves
// the plumbing (retrieval → prompt → schema → code validation → bands → rows);
// it says NOTHING about a real model's accuracy. The real-model eval needs
// ANTHROPIC_API_KEY and is not run here. Also prints a cost-per-batch estimate
// from the size of a real 20-row fixture call.
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, budgetCategoriesTable, categoryDecisionsTable, transactionsTable } from "@workspace/db";
import { fakeCalls, registerFakeFixture, resetFake } from "../ai/fake";
import { invalidateTaskConfigCache } from "../ai/config";
import { costUsd } from "../ai/prices";
import { untrusted } from "../ai/redact";
import { bandFor } from "../lib/categorizer/bands";
import { decideRow } from "../lib/categorizer/decide";
import { runCategorizationBatch } from "../lib/categorizer";
import { AnthropicModelStage, MODEL_BATCH_SIZE } from "../lib/categorizer/modelStage";
import { pinEnv } from "./_helpers/aiEnv";
import { createTestHousehold } from "./_helpers/testHousehold";
import { addTxn, fixtureBy } from "./_helpers/aiCategorize";
import { CATEGORY_NAMES, EVAL_CASES, evalContext } from "./_fixtures/categorizationEval";

pinEnv({ AI_ENABLED: "true", AI_PROVIDER: "fake" });
const OWNER = `ai1-eval-${process.pid}-${randomUUID().slice(0, 8)}`;
let HH = "";
const catByName = new Map<string, string>();

beforeAll(async () => {
  HH = (await createTestHousehold(OWNER)).householdId;
  for (const n of CATEGORY_NAMES) {
    const [c] = await db
      .insert(budgetCategoriesTable)
      .values({ userId: OWNER, householdId: HH, name: n, kind: n === "Income" ? "income" : "expense", groupName: "Eval", excludeFromBudget: n === "Uncategorized" })
      .returning({ id: budgetCategoriesTable.id });
    catByName.set(n, c!.id);
  }
});

describe("categorizer eval with the model stage (fake provider)", () => {
  it("sends only what the deterministic stages left, files an oracle's answers provisionally, and prices a batch", async () => {
    resetFake();
    invalidateTaskConfigCache();
    const ctx = evalContext();
    const scored = EVAL_CASES.filter((k) => !k.row.categoryLockedByUser);
    const left = scored.filter((k) => {
      const r = decideRow(k.row, ctx);
      return !r || bandFor(r.confidence) === "queue";
    });
    const askable = left.filter((k) => k.label !== null && k.row.categoryId == null);
    expect(askable.length).toBeGreaterThanOrEqual(5);

    const ids = new Map<string, (typeof askable)[number]>();
    for (const k of askable) {
      const id = await addTxn(HH, OWNER, {
        description: k.row.description,
        amount: k.row.amount,
        source: k.row.source,
        plaidAccountId: k.row.plaidAccountId,
        pfcPrimary: k.row.pfcPrimary,
        pfcDetailed: k.row.pfcDetailed,
        pending: k.row.pending,
      });
      ids.set(id, k);
    }
    // Oracle: answers each charge with its label (medium). Matches on the wrapped text + amount.
    registerFakeFixture("categorize", (call) => {
      const doc = JSON.parse(call.messages[0]!.content as string) as { charges: Array<{ index: number; merchant: string; amount: number }> };
      return {
        results: doc.charges.flatMap((c) => {
          const hit = askable.find((k) => untrusted("merchant", k.row.description) === c.merchant && Math.abs(Math.abs(Number(k.row.amount)) - Math.abs(c.amount)) < 0.005);
          return hit
            ? [{ index: c.index, categoryId: catByName.get(hit.label!)!, confidence: "medium", isTransfer: false, recurringGuess: null, splitSuggestion: null, rationale: "Oracle." }]
            : [];
        }),
      };
    });
    const stage = new AnthropicModelStage({ autoAllowed: false });
    const out = await runCategorizationBatch(HH, { txnIds: [...ids.keys()], trigger: "job", modelStage: stage });

    let filed = 0;
    let correct = 0;
    for (const [id, k] of ids) {
      const [row] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, id));
      if (row!.categoryId) {
        filed += 1;
        if (row!.categoryId === catByName.get(k.label!)) correct += 1;
        expect(row!.categoryProvisional).toBe(true); // never auto without the gate
      }
    }
    const expectedCalls = Math.ceil(ids.size / MODEL_BATCH_SIZE);
    expect(fakeCalls).toHaveLength(expectedCalls);
    expect(filed).toBe(correct);
    expect(filed).toBeGreaterThanOrEqual(ids.size - 2); // a row a heuristic already queued is not asked again
    expect(out.decisions.filter((d) => d.source === "model").length).toBe(filed);

    // Cost per batch: a FULL 20-row call with 8 priors per row (the upper bound), sized from the real prompt (≈ 4 chars per token).
    resetFake();
    for (let i = 0; i < 12; i++) {
      const t = await addTxn(HH, OWNER, { description: `COST SHOP #${100 + i}`, amount: "-25.00", categoryId: catByName.get("Groceries")!, occurredOn: `2026-09-${String(10 + i).padStart(2, "0")}` });
      await db.insert(categoryDecisionsTable).values({
        householdId: HH, transactionId: t, source: "user", categoryId: catByName.get("Groceries")!, confidence: "1.000", band: "auto", explanation: "x", inputHash: randomUUID(),
      });
    }
    const full: string[] = [];
    for (let i = 0; i < MODEL_BATCH_SIZE; i++) full.push(await addTxn(HH, OWNER, { description: `COST SHOP #${500 + i}`, amount: "-26.00", occurredOn: "2026-10-01" }));
    registerFakeFixture("categorize", fixtureBy([], { cat: catByName.get("Groceries")!, confidence: "medium", rationale: "Same shop as the last twelve charges you filed." }));
    await runCategorizationBatch(HH, { txnIds: full, trigger: "job", modelStage: new AnthropicModelStage({ autoAllowed: false }) });
    const first = fakeCalls[0]!;
    const sysChars = first.system.length;
    const userChars = (first.messages[0]!.content as string).length;
    const doc = JSON.parse(first.messages[0]!.content as string) as { charges: Array<{ priors: unknown[] }> };
    const rows = doc.charges.length;
    expect(rows).toBe(MODEL_BATCH_SIZE);
    expect(doc.charges.every((c) => c.priors.length === 8)).toBe(true);
    const inTok = Math.ceil((sysChars + userChars) / 4);
    const outTok = rows * 55;
    const cold = costUsd("claude-opus-5-5", { inputTokens: inTok, outputTokens: outTok, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const sysTok = Math.ceil(sysChars / 4);
    const warm = costUsd("claude-opus-5-5", { inputTokens: inTok - sysTok, outputTokens: outTok, cacheReadTokens: sysTok, cacheWriteTokens: 0 });
    console.log(
      `\n[categorizer eval + fake model] ambiguous-labelled=${askable.length} asked=${ids.size} calls=${fakeCalls.length} filed(provisional)=${filed} correct=${correct} ` +
        `(oracle fixture: proves plumbing only)\n` +
        `[categorizer eval + fake model] real-model eval: NOT RUN (no ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ? "present" : "absent"})\n` +
        `[categorizer cost] ${rows}-row call: system ${sysChars} chars (~${sysTok} tok), user ${userChars} chars; est input ~${inTok} tok, output ~${outTok} tok ` +
        `→ claude-opus-5-5 $${cold?.toFixed(4)} cold, $${warm?.toFixed(4)} with the system block cached\n`,
    );
  });
});
