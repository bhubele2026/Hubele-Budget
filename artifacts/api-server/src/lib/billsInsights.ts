// Bills insights — Fable 5 savings analysis for the /bills page (both tabs).
//
// Follows avalancheAdvisorSummary.ts exactly: same Anthropic client setup,
// DEFAULT_MODEL, 12s AbortController timeout, 3-layer fallback (AI → deterministic
// template → minimal). Own env override BILLS_ADVISOR_MODEL.
//
// CLAUDE.md §1: every dollar/count here is computed deterministically (recurring
// items expanded, debt minimums, one-off = this month's real spend not tied to a
// recurring bill). Fable 5 only writes the headline + savings-suggestion bullets —
// it never invents a number and never fabricates a savings amount.

import Anthropic from "@anthropic-ai/sdk";
import {
  db,
  recurringItemsTable,
  debtsTable,
  budgetCategoriesTable,
  transactionsTable,
} from "@workspace/db";
import { and, eq, gte, lte } from "drizzle-orm";
import { logger } from "./logger";
import { VOICE_SYSTEM } from "./advisorVoice";
import { expandItem, fmtISO } from "./cashSignal";
import { buildDebtMinSchedule, buildAvalancheExtraRow } from "./debtMinSchedule";
import { type SpendContext } from "./spendingFilter";
import { computeOneOff } from "./billsOneOff";

const DEFAULT_MODEL = "claude-fable-5";
const MAX_OUTPUT_TOKENS = 600;
const ANTHROPIC_TIMEOUT_MS = 12_000;

let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (process.env.ADVISOR_ENABLED === "false") return null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!_client) _client = new Anthropic({ apiKey });
  return _client;
}
function getModel(): string {
  return process.env.BILLS_ADVISOR_MODEL || DEFAULT_MODEL;
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Deterministic facts
// ---------------------------------------------------------------------------

export interface BillFact {
  name: string;
  monthly: number;
  annual: number;
  category: string | null;
}

export interface BillsFacts {
  monthLabel: string;
  income: number;
  bills: number;
  debtMin: number;
  totalOutflow: number;
  net: number;
  topBills: BillFact[];
  oneOffTotal: number;
  oneOffCount: number;
  topOneOff: { name: string; amount: number }[];
  hashInput: unknown;
}

function todayDate(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export async function buildBillsFacts(
  householdId: string,
  monthISO?: string,
): Promise<BillsFacts> {
  const today = todayDate();
  const monthMatch = /^(\d{4})-(\d{2})-01$/.exec(monthISO ?? "");
  const viewYear = monthMatch ? Number(monthMatch[1]) : today.getFullYear();
  const viewMonth0 = monthMatch ? Number(monthMatch[2]) - 1 : today.getMonth();
  const monthStart = new Date(viewYear, viewMonth0, 1);
  const monthEnd = new Date(viewYear, viewMonth0 + 1, 0);
  const monthStartISO = fmtISO(monthStart);
  const monthEndISO = fmtISO(monthEnd);
  const monthLabel = monthStart.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  const items = await db
    .select()
    .from(recurringItemsTable)
    .where(eq(recurringItemsTable.householdId, householdId));
  const debts = await db
    .select()
    .from(debtsTable)
    .where(eq(debtsTable.householdId, householdId));

  // Debt minimums (+ optional avalanche extra), and which recurring items are
  // debt-linked (suppressed from the bills list to avoid double counting) —
  // exactly as the /bills/summary route does.
  const { rows: debtMinRows, suppressedRecurringIds } = buildDebtMinSchedule(
    debts,
    items,
    today,
  );
  const extra = buildAvalancheExtraRow(debts, 0, today); // manualExtra unused for facts
  if (extra) debtMinRows.push(extra);

  let income = 0;
  let bills = 0;
  const billFacts: BillFact[] = [];
  const activeBillNames: string[] = [];
  for (const item of items) {
    if (item.active !== "true") continue;
    if (item.kind !== "income") activeBillNames.push(item.name);
    if (suppressedRecurringIds.has(item.id)) continue;
    const events = expandItem(item, monthStart, monthEnd);
    const monthly = events.reduce((s, e) => s + Math.abs(e.amount), 0);
    if (item.kind === "income") {
      income += monthly;
    } else {
      bills += monthly;
      billFacts.push({
        name: item.name,
        monthly: round2(monthly),
        annual: round2(monthly * 12),
        category: null,
      });
    }
  }
  const debtMin = debtMinRows.reduce(
    (s, r) => s + Math.abs(Number(r.amount) || 0),
    0,
  );
  const totalOutflow = bills + debtMin;
  const net = income - totalOutflow;
  const topBills = billFacts
    .sort((a, b) => b.monthly - a.monthly)
    .slice(0, 6);

  // ── One-off / non-recurring spend this month (month-scoped, NOT limit:5000) ──
  const cats = await db
    .select({
      id: budgetCategoriesTable.id,
      name: budgetCategoriesTable.name,
      debtId: budgetCategoriesTable.debtId,
      kind: budgetCategoriesTable.kind,
    })
    .from(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.householdId, householdId));
  const categoriesById = new Map<
    string,
    { name: string; debtId: string | null; kind: string }
  >();
  const debtCategoryIds = new Set<string>();
  for (const c of cats) {
    categoriesById.set(c.id, { name: c.name, debtId: c.debtId, kind: c.kind });
    if (c.debtId) debtCategoryIds.add(c.id);
  }
  const ctx: SpendContext = { categoriesById, debtCategoryIds };

  const monthTxns = await db
    .select({
      description: transactionsTable.description,
      amount: transactionsTable.amount,
      source: transactionsTable.source,
      categoryId: transactionsTable.categoryId,
      isTransfer: transactionsTable.isTransfer,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        gte(transactionsTable.occurredOn, monthStartISO),
        lte(transactionsTable.occurredOn, monthEndISO),
      ),
    );

  const { total: oneOffTotal, count: oneOffCount, top: topOneOff } =
    computeOneOff(monthTxns, ctx, activeBillNames);

  const facts: BillsFacts = {
    monthLabel,
    income: round2(income),
    bills: round2(bills),
    debtMin: round2(debtMin),
    totalOutflow: round2(totalOutflow),
    net: round2(net),
    topBills,
    oneOffTotal: round2(oneOffTotal),
    oneOffCount,
    topOneOff,
    hashInput: null,
  };
  facts.hashInput = {
    m: monthLabel,
    i: facts.income,
    b: facts.bills,
    d: facts.debtMin,
    tb: topBills.map((b) => [b.name, b.monthly]),
    oo: facts.oneOffTotal,
  };
  return facts;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `${VOICE_SYSTEM}

TASK: Analyze the household's monthly bills and give a couple of concrete money-saving ideas. The app has computed every number deterministically (income, recurring bills, debt minimums, net, the biggest bills, and one-off spend). Narrate and advise — never compute, never invent a number.

Output requirements:
- Respond with ONLY a JSON object, no markdown fence, no preamble.
- Schema: {"headline": string, "bullets": string[]}
- headline: <= 8 words, a plain-language read on the bill picture.
- bullets: 2-4 short strings. Each names a REAL bill from the FACTS with its real monthly/annual cost, and suggests a concrete behavioral way to try to save on it (shop the rate, downgrade a tier, cancel, renegotiate, consolidate). Reference only amounts in the FACTS.

Rules:
- Whole dollars only (no cents).
- NEVER invent a savings amount — you may cite a bill's real cost from FACTS, but do not fabricate "you'd save $X".
- If there's nothing worth flagging, return one honest bullet saying the bills look lean.`;

function formatFactsForPrompt(f: BillsFacts): string {
  const lines: string[] = [];
  lines.push(`MONTH: ${f.monthLabel}`);
  lines.push(
    `Income ${money(f.income)}/mo · Recurring bills ${money(f.bills)}/mo · Debt minimums ${money(f.debtMin)}/mo · Total outflow ${money(f.totalOutflow)}/mo · Net ${money(f.net)}/mo`,
  );
  lines.push("");
  lines.push("BIGGEST RECURRING BILLS:");
  if (f.topBills.length === 0) lines.push("  none");
  for (const b of f.topBills)
    lines.push(`  ${b.name}: ${money(b.monthly)}/mo (${money(b.annual)}/yr)`);
  lines.push("");
  lines.push(
    `ONE-OFF / NON-RECURRING SPEND THIS MONTH: ${money(f.oneOffTotal)} across ${f.oneOffCount} charges`,
  );
  for (const o of f.topOneOff) lines.push(`  ${o.name}: ${money(o.amount)}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Output + parse + fallback
// ---------------------------------------------------------------------------

export interface BillsInsightsSummaryRow {
  headline: string;
  bullets: string[];
  /** One-off / non-recurring spend this month (computed in facts; surfaced so
   *  the Overview can show recurring vs one-off without a second call). */
  oneOffTotal: number;
  oneOffCount: number;
  summarySource: "ai" | "fallback";
  generatedAt: string;
}

function parseLLMResponse(raw: string): { headline: string; bullets: string[] } | null {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  const headline = typeof p.headline === "string" ? p.headline.trim() : "";
  const bullets = Array.isArray(p.bullets)
    ? p.bullets.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : [];
  if (!headline || bullets.length === 0) return null;
  return { headline, bullets };
}

export function buildFallbackSummary(f: BillsFacts): BillsInsightsSummaryRow {
  const top = f.topBills[0];
  const bullets: string[] = [];
  if (top)
    bullets.push(
      `${top.name} is your biggest bill at ${money(top.monthly)}/mo (${money(top.annual)}/yr) — worth shopping the rate.`,
    );
  if (f.topBills[1])
    bullets.push(
      `${f.topBills[1].name} runs ${money(f.topBills[1].monthly)}/mo — check for a lower tier or a bundle.`,
    );
  if (f.oneOffTotal > 0)
    bullets.push(
      `${money(f.oneOffTotal)} of one-off spend this month across ${f.oneOffCount} charges — the easiest place to trim.`,
    );
  if (bullets.length === 0)
    bullets.push("Your bills look lean — nothing obvious to cut right now.");
  return {
    headline:
      f.net >= 0
        ? `${money(f.income)} in, ${money(f.totalOutflow)} out`
        : "Outflow is running ahead of income",
    bullets,
    oneOffTotal: f.oneOffTotal,
    oneOffCount: f.oneOffCount,
    summarySource: "fallback",
    generatedAt: new Date().toISOString(),
  };
}

async function callAnthropicWithTimeout(
  facts: BillsFacts,
): Promise<{ headline: string; bullets: string[] } | null> {
  const client = getClient();
  if (!client) return null;
  const userPrompt = `FACTS:\n${formatFactsForPrompt(facts)}\n\nWrite the JSON now.`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ANTHROPIC_TIMEOUT_MS);
  try {
    const res = await client.messages.create(
      {
        model: getModel(),
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      },
      { signal: ctrl.signal },
    );
    const textBlock = res.content.find((c) => c.type === "text");
    if (!textBlock || textBlock.type !== "text") return null;
    return parseLLMResponse(textBlock.text);
  } finally {
    clearTimeout(timer);
  }
}

export async function generateBillsInsightsSummary(
  facts: BillsFacts,
): Promise<BillsInsightsSummaryRow> {
  try {
    const llm = await callAnthropicWithTimeout(facts);
    if (llm)
      return {
        headline: llm.headline,
        bullets: llm.bullets,
        oneOffTotal: facts.oneOffTotal,
        oneOffCount: facts.oneOffCount,
        summarySource: "ai",
        generatedAt: new Date().toISOString(),
      };
    logger.warn("bills-insights: LLM returned no usable summary, using fallback");
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "bills-insights: LLM call failed, using fallback",
    );
  }
  try {
    return buildFallbackSummary(facts);
  } catch {
    return {
      headline: "Bill analysis ready",
      bullets: ["The numbers are on the cards below."],
      oneOffTotal: facts.oneOffTotal,
      oneOffCount: facts.oneOffCount,
      summarySource: "fallback",
      generatedAt: new Date().toISOString(),
    };
  }
}
