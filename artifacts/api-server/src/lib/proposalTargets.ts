import { and, eq, lt } from "drizzle-orm";
import {
  agentProposalsTable,
  avalancheSettingsTable,
  budgetCategoriesTable,
  budgetLinesTable,
  db,
  recurringItemsTable,
  type AgentProposal,
} from "@workspace/db";
import { householdTodayISO } from "./householdClock";
import { loadAllowancePlans } from "./allowancePlans";

// (AI-2) What a proposal may point at, checked before it is stored and again
// before it is applied. READ-ONLY: the writers are in proposalApply.ts, which
// only routes/ai.ts imports (a model never reaches them).

export const PROPOSAL_KINDS = ["set_category", "weekly_limit", "budget_line", "extra_debt_payment", "bill_amount"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];
export const PLAN_CHANGE_KINDS = ["weekly_limit", "budget_line", "extra_debt_payment", "bill_amount"] as const;
export type PlanChangeKind = (typeof PLAN_CHANGE_KINDS)[number];
export const PROPOSAL_TTL_DAYS = 14;
export const MAX_PROPOSED_AMOUNT = 1_000_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
const r2 = (n: number): number => Math.round(n * 100) / 100;

export interface PlanPayload {
  /** The id (or "avalanche") the change points at. */
  target: string;
  /** What code read as the current figure — never the model's claim. */
  before: number;
  after: number;
  /** A name for the screen, read from the household's own rows. */
  label: string;
  monthStart?: string;
}

export type TargetResult = { ok: true; payload: PlanPayload } | { ok: false; error: "not_found" | "invalid_amount" | "not_supported" };

export const monthStartOf = (todayISO: string): string => `${todayISO.slice(0, 7)}-01`;

/** The weekly plan that governs today: the pool's newest row that has started. */
export async function currentWeeklyPlan(householdId: string, todayISO = householdTodayISO()) {
  const plans = (await loadAllowancePlans(householdId)).filter(
    (p) => p.period === "weekly" && p.memberUserId === null && p.effectiveFrom <= todayISO,
  );
  return plans.length ? plans[plans.length - 1]! : null; // loadAllowancePlans is oldest-first
}

export async function resolvePlanTarget(
  householdId: string,
  ownerUserId: string,
  kind: PlanChangeKind,
  target: string,
  after: number,
): Promise<TargetResult> {
  if (!Number.isFinite(after) || after < 0 || after > MAX_PROPOSED_AMOUNT) return { ok: false, error: "invalid_amount" };
  const to = r2(after);
  const today = householdTodayISO();
  if (kind === "weekly_limit") {
    const plans = await loadAllowancePlans(householdId);
    const plan =
      target === "weekly"
        ? await currentWeeklyPlan(householdId, today)
        : isUuid(target)
          ? plans.find((p) => p.id === target && p.period === "weekly")
          : null;
    if (!plan) return { ok: false, error: "not_found" };
    return { ok: true, payload: { target: plan.id, before: r2(Number(plan.amount)), after: to, label: "Weekly limit" } };
  }
  if (kind === "budget_line") {
    if (!isUuid(target)) return { ok: false, error: "not_found" };
    const [cat] = await db
      .select({ id: budgetCategoriesTable.id, name: budgetCategoriesTable.name, kind: budgetCategoriesTable.kind, sourceKind: budgetCategoriesTable.sourceKind })
      .from(budgetCategoriesTable)
      .where(and(eq(budgetCategoriesTable.id, target), eq(budgetCategoriesTable.householdId, householdId)));
    if (!cat) return { ok: false, error: "not_found" };
    // The avalanche payment line is the avalanche slider's: use extra_debt_payment.
    if (cat.kind !== "expense" || cat.sourceKind !== "manual") return { ok: false, error: "not_supported" };
    const monthStart = monthStartOf(today);
    const [line] = await db
      .select({ planned: budgetLinesTable.plannedAmount })
      .from(budgetLinesTable)
      .where(and(eq(budgetLinesTable.householdId, householdId), eq(budgetLinesTable.monthStart, monthStart), eq(budgetLinesTable.categoryId, cat.id)));
    return { ok: true, payload: { target: cat.id, before: r2(Number(line?.planned ?? 0)), after: to, label: cat.name, monthStart } };
  }
  if (kind === "extra_debt_payment") {
    const [s] = await db
      .select({ manualExtra: avalancheSettingsTable.manualExtra })
      .from(avalancheSettingsTable)
      .where(eq(avalancheSettingsTable.userId, ownerUserId));
    return { ok: true, payload: { target: "avalanche", before: r2(Number(s?.manualExtra ?? 0)), after: to, label: "Extra debt payment" } };
  }
  // bill_amount
  if (!isUuid(target)) return { ok: false, error: "not_found" };
  const [item] = await db
    .select()
    .from(recurringItemsTable)
    .where(and(eq(recurringItemsTable.id, target), eq(recurringItemsTable.householdId, householdId)));
  if (!item) return { ok: false, error: "not_found" };
  if (item.kind !== "bill" || item.frequency === "onetime") return { ok: false, error: "not_supported" };
  return { ok: true, payload: { target: item.id, before: r2(Number(item.amount)), after: to, label: item.name } };
}

export interface ProposalView {
  id: string;
  kind: string;
  status: string;
  payload: unknown;
  rationale: string;
  runId: string;
  decidedBy: string | null;
  decidedAt: string | null;
  appliedActionId: string | null;
  expiresAt: string;
  createdAt: string;
}

export function proposalView(p: AgentProposal): ProposalView {
  return {
    id: p.id,
    kind: p.kind,
    status: p.status,
    payload: p.payload,
    rationale: p.rationale,
    runId: p.runId,
    decidedBy: p.decidedBy,
    decidedAt: p.decidedAt ? p.decidedAt.toISOString() : null,
    appliedActionId: p.appliedActionId,
    expiresAt: p.expiresAt.toISOString(),
    createdAt: p.createdAt.toISOString(),
  };
}

/** Lazily expire the household's open proposals past their date. */
export async function expireProposals(householdId: string, now = new Date()): Promise<number> {
  const rows = await db
    .update(agentProposalsTable)
    .set({ status: "expired" })
    .where(
      and(
        eq(agentProposalsTable.householdId, householdId),
        eq(agentProposalsTable.status, "proposed"),
        // expires_at < now, written as a bound comparison
        lt(agentProposalsTable.expiresAt, now),
      ),
    )
    .returning({ id: agentProposalsTable.id });
  return rows.length;
}

/**
 * Create (or refresh) the open proposal for a kind and target: asking twice
 * about the same thing keeps one row.
 */
export async function createProposal(
  householdId: string,
  runId: string,
  kind: ProposalKind,
  payload: Record<string, unknown>,
  rationale: string,
  now = new Date(),
): Promise<{ proposal: AgentProposal; refreshed: boolean }> {
  await expireProposals(householdId, now);
  const open = await db
    .select()
    .from(agentProposalsTable)
    .where(and(eq(agentProposalsTable.householdId, householdId), eq(agentProposalsTable.kind, kind), eq(agentProposalsTable.status, "proposed")));
  const same = open.find((p) => (p.payload as { target?: string }).target === payload.target);
  const expiresAt = new Date(now.getTime() + PROPOSAL_TTL_DAYS * 86_400_000);
  if (same) {
    const [row] = await db
      .update(agentProposalsTable)
      .set({ payload, rationale, runId, expiresAt })
      .where(and(eq(agentProposalsTable.id, same.id), eq(agentProposalsTable.householdId, householdId)))
      .returning();
    return { proposal: row!, refreshed: true };
  }
  const [row] = await db
    .insert(agentProposalsTable)
    .values({ householdId, runId, kind, payload, rationale, expiresAt })
    .returning();
  return { proposal: row!, refreshed: false };
}
