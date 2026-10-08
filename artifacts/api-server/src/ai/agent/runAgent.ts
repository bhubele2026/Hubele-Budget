import { and, desc, eq, sql } from "drizzle-orm";
import {
  agentConversationsTable,
  agentMessagesTable,
  agentRunsTable,
  aiUsageTable,
  db,
} from "@workspace/db";
import type Anthropic from "@anthropic-ai/sdk";
import { logger } from "../../lib/logger";
import { assertBudget } from "../budget";
import { getProvider, isAiEnabled } from "../client";
import { getTaskConfig } from "../config";
import { classifyError } from "../errors";
import { costUsd } from "../prices";
import { resolvePrompt } from "../prompts";
import { AiFailure, type AiFailureKind } from "../types";
import { recordUsage, type AiUsageStatus } from "../usage";
import type { AgentTool, ToolLoopResponse } from "../provider";
import { makeTools } from "../tools";
import type { ToolContext } from "../tools/context";
import { checkGrounding, collectFigures, withGroundingCaveat } from "./grounding";

// (AI-2) One question to the Ask agent.
//
//   run row (chat, user) → persist the question → enabled? → assertBudget →
//   history (last 12 turns, ≤ 6K tokens, cut by code) → tool loop (≤ 8 turns,
//   90 s) → usage rows (one per API request) → grounding check → persist the
//   answer → close the run from the ai_usage rows.
//
// The model reads through tools and proposes through tools. It writes no
// money. The run's `summary` is counts only.

export const HISTORY_MESSAGES = 12;
export const HISTORY_TOKEN_CAP = 6000;
export const MESSAGE_CHAR_CAP = 4000;
export const WALL_CLOCK_MS = 90_000;
const approxTokens = (s: string): number => Math.ceil(s.length / 4);

export type AiChatEvent =
  | { type: "token"; text: string }
  | { type: "tool"; name: string; status: "running" | "done" | "error" }
  | { type: "done"; runId: string; messageId: string; text: string; grounded: boolean; demo: boolean }
  | { type: "error"; code: string; message: string; retryable: boolean; runId?: string };

export interface RunAgentArgs {
  ctx: Omit<ToolContext, "runId">;
  conversationId: string;
  userText: string;
  userAskedToChange?: boolean;
  onEvent: (e: AiChatEvent) => void;
  /** Aborts the run (the browser went away). */
  signal?: AbortSignal;
}

export interface RunAgentResult {
  runId: string;
  status: "succeeded" | "failed" | "refused" | "budget_exceeded";
  messageId: string | null;
  text: string | null;
  grounded: boolean | null;
  errorCode: string | null;
}

/** The last turns of the conversation as plain text, newest kept, cut by code. */
export async function loadHistory(conversationId: string): Promise<Array<{ role: "user" | "assistant"; text: string }>> {
  const rows = await db
    .select({ role: agentMessagesTable.role, content: agentMessagesTable.content })
    .from(agentMessagesTable)
    .where(and(eq(agentMessagesTable.conversationId, conversationId), sql`${agentMessagesTable.role} in ('user','assistant')`))
    .orderBy(desc(agentMessagesTable.createdAt), desc(agentMessagesTable.id))
    .limit(HISTORY_MESSAGES);
  const kept: Array<{ role: "user" | "assistant"; text: string }> = [];
  let tokens = 0;
  for (const r of rows) {
    const raw = (r.content as { text?: unknown })?.text;
    if (typeof raw !== "string" || !raw.trim()) continue;
    const text = raw.length > MESSAGE_CHAR_CAP ? raw.slice(0, MESSAGE_CHAR_CAP) : raw;
    tokens += approxTokens(text);
    if (tokens > HISTORY_TOKEN_CAP) break;
    kept.unshift({ role: r.role as "user" | "assistant", text });
  }
  while (kept.length && kept[0]!.role !== "user") kept.shift();
  return kept;
}

async function closeRun(
  runId: string,
  status: "succeeded" | "failed" | "refused" | "budget_exceeded",
  summary: string,
  error?: string,
): Promise<void> {
  const [t] = await db
    .select({
      input: sql<number>`coalesce(sum(${aiUsageTable.inputTokens}), 0)::int`,
      output: sql<number>`coalesce(sum(${aiUsageTable.outputTokens}), 0)::int`,
      cost: sql<string>`coalesce(sum(${aiUsageTable.costUsd}), 0)::text`,
    })
    .from(aiUsageTable)
    .where(eq(aiUsageTable.runId, runId));
  await db
    .update(agentRunsTable)
    .set({
      status,
      finishedAt: new Date(),
      inputTokens: t?.input ?? 0,
      outputTokens: t?.output ?? 0,
      costUsd: Number(t?.cost ?? 0).toFixed(6),
      summary: summary.slice(0, 300),
      ...(error ? { error: error.slice(0, 300) } : {}),
    })
    .where(eq(agentRunsTable.id, runId));
}

const FAILURE_COPY: Record<string, string> = {
  disabled: "Ask is turned off right now.",
  budget_exceeded: "Ask has reached its limit for now.",
  rate_limited: "Ask is busy. Try again in a minute.",
  timeout: "That took too long. Try a narrower question.",
  connection: "Could not reach the assistant. Try again.",
  api_error: "The assistant had a problem. Try again.",
  refusal: "I can't help with that one.",
  max_tokens: "That answer got too long. Try a narrower question.",
  too_many_steps: "That needed too many steps. Try a narrower question.",
  empty: "I did not get an answer. Try again.",
};

export async function runAgent(args: RunAgentArgs): Promise<RunAgentResult> {
  const { conversationId, userText, onEvent } = args;
  const ctx0 = { ...args.ctx, userAskedToChange: args.userAskedToChange ?? args.ctx.userAskedToChange ?? false };
  const { householdId } = ctx0;

  const [run] = await db
    .insert(agentRunsTable)
    .values({ householdId, kind: "chat", trigger: "user", status: "running", conversationId })
    .returning({ id: agentRunsTable.id });
  const runId = run!.id;
  const ctx: ToolContext = { ...ctx0, runId };

  const finish = async (
    status: RunAgentResult["status"],
    code: string,
    summary: string,
    retryable = false,
    detail?: string,
  ): Promise<RunAgentResult> => {
    await closeRun(runId, status, summary, detail ?? FAILURE_COPY[code] ?? code);
    onEvent({ type: "error", code, message: FAILURE_COPY[code] ?? "Something went wrong.", retryable, runId });
    return { runId, status, messageId: null, text: null, grounded: null, errorCode: code };
  };

  try {
    // The question is kept whether or not it can be answered.
    await db.insert(agentMessagesTable).values({ conversationId, role: "user", content: { text: userText }, runId });

    const cfg = await getTaskConfig("chat");
    if (!isAiEnabled() || !cfg.enabled) return await finish("failed", "disabled", "chat: AI is off");
    try {
      await assertBudget(householdId, "chat");
    } catch (err) {
      const f = classifyError(err);
      if (err instanceof AiFailure && err.kind === "budget_exceeded") {
        await recordUsage({ householdId, task: "chat", model: cfg.model, runId, costUsd: 0, status: "budget_exceeded" });
        return await finish("budget_exceeded", "budget_exceeded", "chat: blocked by the budget", false, f.message);
      }
      throw err;
    }

    const prompt = resolvePrompt("chat");
    if (!prompt) throw new Error("no chat prompt registered");
    const history = await loadHistory(conversationId);
    // The question was just stored, so it is the history's last turn: send it once.
    const prior = history.length && history[history.length - 1]!.role === "user" && history[history.length - 1]!.text === userText.slice(0, MESSAGE_CHAR_CAP) ? history.slice(0, -1) : history;
    const messages: Anthropic.MessageParam[] = prompt.build({ history: prior, userText });

    // Tools, wrapped so the screen sees each call and the trail keeps it.
    const toolResults: string[] = [];
    const toolNames: string[] = [];
    const tools: AgentTool[] = makeTools(ctx).map((t) => ({
      ...t,
      run: async (input: unknown) => {
        onEvent({ type: "tool", name: t.name, status: "running" });
        const out = await t.run(input);
        toolResults.push(out);
        toolNames.push(t.name);
        const failed = /^\{"error":/.test(out);
        onEvent({ type: "tool", name: t.name, status: failed ? "error" : "done" });
        await db
          .insert(agentMessagesTable)
          .values({ conversationId, role: "tool", content: { name: t.name, input, result: out }, runId })
          .catch((e) => logger.warn({ err: e }, "agent: could not store a tool message"));
        return out;
      },
    }));

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error("wall-clock")), WALL_CLOCK_MS);
    const onClientGone = (): void => ac.abort(new Error("client-gone"));
    args.signal?.addEventListener("abort", onClientGone, { once: true });
    const provider = getProvider();
    const t0 = Date.now();

    const ledger = async (turns: ToolLoopResponse["turns"], demo: boolean, lastStatus: AiUsageStatus): Promise<void> => {
      for (let i = 0; i < turns.length; i++) {
        const turn = turns[i]!;
        await recordUsage({
          householdId,
          task: "chat",
          model: turn.model,
          promptVersion: prompt.PROMPT_VERSION,
          runId,
          usage: turn.usage,
          costUsd: demo ? 0 : costUsd(turn.model, turn.usage),
          latencyMs: i === turns.length - 1 ? Date.now() - t0 : null,
          status: i === turns.length - 1 ? lastStatus : "ok",
          requestId: turn.requestId,
        });
      }
    };

    let res: ToolLoopResponse;
    try {
      res = await provider.runTools({
        task: "chat",
        model: cfg.model,
        effort: cfg.effort,
        maxTokens: cfg.maxTokens,
        maxIterations: cfg.maxIterations,
        system: prompt.system,
        messages,
        tools,
        signal: ac.signal,
        onText: (text) => onEvent({ type: "token", text }),
      });
    } catch (err) {
      const f = classifyError(err);
      const aborted = ac.signal.aborted;
      const kind: AiFailureKind = aborted ? "timeout" : f.kind;
      const turns = (err as { turns?: ToolLoopResponse["turns"] } | null)?.turns ?? [];
      if (turns.length) await ledger(turns, provider.name === "fake", kind);
      else await recordUsage({ householdId, task: "chat", model: cfg.model, promptVersion: prompt.PROMPT_VERSION, runId, costUsd: null, latencyMs: Date.now() - t0, status: kind, requestId: f.requestId ?? null });
      logger.warn({ ai: { task: "chat", status: kind, aborted } }, "AI chat call failed");
      return await finish("failed", kind, `chat: failed (${kind}), ${toolNames.length} tool calls`, f.retryable, f.message);
    } finally {
      clearTimeout(timer);
      args.signal?.removeEventListener("abort", onClientGone);
    }

    const stop = res.stopReason;
    const lastStatus: AiUsageStatus = stop === "refusal" ? "refusal" : stop === "max_tokens" ? "max_tokens" : "ok";
    await ledger(res.turns, res.demo, lastStatus);

    if (stop === "refusal") return await finish("refused", "refusal", "chat: the model declined");
    if (stop === "max_tokens") return await finish("failed", "max_tokens", "chat: output cut off");
    if (stop === "tool_use") return await finish("failed", "too_many_steps", `chat: stopped at the step cap, ${toolNames.length} tool calls`);
    if (!res.text.trim()) return await finish("failed", "empty", "chat: empty answer");

    const known = collectFigures([...toolResults, userText]);
    const grounding = checkGrounding(res.text, known);
    const finalText = withGroundingCaveat(res.text.trim(), grounding);

    const [msg] = await db
      .insert(agentMessagesTable)
      .values({
        conversationId,
        role: "assistant",
        content: { text: finalText, grounded: grounding.ok, demo: res.demo, tools: toolNames },
        runId,
      })
      .returning({ id: agentMessagesTable.id });
    await db
      .update(agentConversationsTable)
      .set({ lastMessageAt: new Date() })
      .where(eq(agentConversationsTable.id, conversationId));

    await closeRun(
      runId,
      "succeeded",
      `chat: ${toolNames.length} tool calls${toolNames.length ? ` (${[...new Set(toolNames)].join(", ")})` : ""}; ${grounding.ok ? "figures verified" : `${grounding.ungrounded.length} figures could not be verified`}`,
    );
    onEvent({ type: "done", runId, messageId: msg!.id, text: finalText, grounded: grounding.ok, demo: res.demo });
    return { runId, status: "succeeded", messageId: msg!.id, text: finalText, grounded: grounding.ok, errorCode: null };
  } catch (err) {
    logger.error({ err }, "agent: run crashed");
    return await finish("failed", "api_error", "chat: internal error", true, err instanceof Error ? err.message : String(err));
  }
}

