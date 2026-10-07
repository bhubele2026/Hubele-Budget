import { db, aiBudgetTable, aiUsageTable } from "@workspace/db";
import { and, eq, gte, notInArray, sql } from "drizzle-orm";
import type { AiTask } from "./config";
import { AiFailure } from "./types";

// (AI-0) Spend caps, checked before every model call.
//
//   per-household pause  ai_budget.paused_until > now  → every task stops
//   hard cap             month-to-date ≥ hard_cap_usd (40) → every task stops
//   soft cap             month-to-date ≥ monthly_cap_usd (25) → chat-class stops
//   daily call caps      today's calls for the task ≥ cap → that task stops
//
// "Month" and "day" are UTC calendar periods. Month-to-date is the sum of
// ai_usage.cost_usd (rows with an unknown price add nothing — and were
// warned about when written). A "call" is one API request; blocked rows are
// not calls.

export const DEFAULT_MONTHLY_CAP_USD = 25;
export const DEFAULT_HARD_CAP_USD = 40;
export const DEFAULT_DAILY_CAPS: Readonly<Partial<Record<AiTask, number>>> = {
  chat: 40,
  categorize: 20,
  recap: 3,
  receipt: 15,
  sms_question: 10,
};
/** Conversational tasks stop at the soft cap; everything else runs to the hard cap. */
export const CHAT_CLASS_TASKS: ReadonlySet<AiTask> = new Set<AiTask>(["chat", "sms_question"]);
/** Tasks that may run with no household to charge (owner-run evals). */
export const HOUSEHOLDLESS_TASKS: ReadonlySet<AiTask> = new Set<AiTask>(["eval_judge"]);
/** ai_usage statuses that are not calls (nothing was sent). */
export const BLOCKED_STATUSES = ["budget_exceeded", "disabled"] as const;

export function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function money(v: string | number | null | undefined, fallback: number): number {
  const n = typeof v === "number" ? v : v == null ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function dailyCapsFrom(raw: unknown): Partial<Record<AiTask, number>> {
  const caps: Partial<Record<AiTask, number>> = { ...DEFAULT_DAILY_CAPS };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isInteger(v) && v >= 0) {
        caps[k as AiTask] = v;
      }
    }
  }
  return caps;
}

export interface BudgetState {
  monthToDateUsd: number;
  monthlyCapUsd: number;
  hardCapUsd: number;
  dailyCaps: Partial<Record<AiTask, number>>;
  pausedUntil: Date | null;
}

export async function getBudgetState(householdId: string, now: Date = new Date()): Promise<BudgetState> {
  const [row] = await db
    .select()
    .from(aiBudgetTable)
    .where(eq(aiBudgetTable.householdId, householdId));
  const [mtd] = await db
    .select({ total: sql<string>`coalesce(sum(${aiUsageTable.costUsd}), 0)::text` })
    .from(aiUsageTable)
    .where(
      and(
        eq(aiUsageTable.householdId, householdId),
        gte(aiUsageTable.createdAt, startOfUtcMonth(now)),
        sql`${aiUsageTable.createdAt} <= ${now.toISOString()}::timestamptz`,
      ),
    );
  return {
    monthToDateUsd: Number(mtd?.total ?? 0),
    monthlyCapUsd: money(row?.monthlyCapUsd, DEFAULT_MONTHLY_CAP_USD),
    hardCapUsd: money(row?.hardCapUsd, DEFAULT_HARD_CAP_USD),
    dailyCaps: dailyCapsFrom(row?.dailyCaps),
    pausedUntil: row?.pausedUntil ?? null,
  };
}

export async function callsToday(householdId: string, task: AiTask, now: Date = new Date()): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(aiUsageTable)
    .where(
      and(
        eq(aiUsageTable.householdId, householdId),
        eq(aiUsageTable.task, task),
        gte(aiUsageTable.createdAt, startOfUtcDay(now)),
        sql`${aiUsageTable.createdAt} <= ${now.toISOString()}::timestamptz`,
        notInArray(aiUsageTable.status, [...BLOCKED_STATUSES]),
      ),
    );
  return r?.n ?? 0;
}

function blocked(message: string): AiFailure {
  return new AiFailure({ kind: "budget_exceeded", retryable: false, message });
}

/** Throws AiFailure{kind:"budget_exceeded"} when this call may not run. */
export async function assertBudget(
  householdId: string | null,
  task: AiTask,
  now: Date = new Date(),
): Promise<void> {
  if (!householdId) {
    if (HOUSEHOLDLESS_TASKS.has(task)) return;
    throw blocked(`AI task ${task} needs a household to charge`);
  }
  const state = await getBudgetState(householdId, now);
  if (state.pausedUntil && state.pausedUntil.getTime() > now.getTime()) {
    throw blocked(`AI is paused for this household until ${state.pausedUntil.toISOString()}`);
  }
  if (state.monthToDateUsd >= state.hardCapUsd) {
    throw blocked(`Monthly AI limit reached ($${state.hardCapUsd.toFixed(2)})`);
  }
  if (CHAT_CLASS_TASKS.has(task) && state.monthToDateUsd >= state.monthlyCapUsd) {
    throw blocked(`Monthly AI budget reached ($${state.monthlyCapUsd.toFixed(2)}) — ${task} is paused until next month`);
  }
  const cap = state.dailyCaps[task];
  if (cap !== undefined) {
    const n = await callsToday(householdId, task, now);
    if (n >= cap) throw blocked(`Daily limit for ${task} reached (${cap} calls)`);
  }
}
