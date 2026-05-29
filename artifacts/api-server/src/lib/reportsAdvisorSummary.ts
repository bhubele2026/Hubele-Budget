// (Play B) Per-tab Claude narrative for the five Reports tabs.
//
// Follows avalancheAdvisorSummary.ts / debriefAdvisorSummary.ts exactly:
// same Anthropic client setup, same DEFAULT_MODEL ("claude-sonnet-4-5"),
// same 12s AbortController timeout, same 3-layer fallback
// (AI call -> deterministic template -> minimal single-line summary).
//
// Each tab has its own DETERMINISTIC facts builder that loads the
// household's real data and produces (a) a list of fact lines for the
// prompt and (b) a deterministic fallback headline + bullets. Claude
// only narrates the facts — it never invents numbers.

import Anthropic from "@anthropic-ai/sdk";
import {
  db,
  transactionsTable,
  debtsTable,
  budgetLinesTable,
  budgetCategoriesTable,
  type ReportsAdvisorSummary,
  type ReportsAdvisorTab,
} from "@workspace/db";
import { and, eq, gte, lte, sql, desc } from "drizzle-orm";
import { logger } from "./logger";
import { computeCashSignal } from "./cashSignal";
import { buildAvalancheSchedule } from "./avalancheScheduler";
import { buildSpendingFacts as buildSpendingFactsPipeline } from "./spendingFacts";

const DEFAULT_MODEL = "claude-sonnet-4-5";
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
  return process.env.ADVISOR_MODEL || DEFAULT_MODEL;
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}
function num(v: string | number | null | undefined): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
function pct(n: number): string {
  return `${Math.round(n)}%`;
}

// ---------------------------------------------------------------------------
// Tab facts — each builder returns the deterministic material for one tab.
// ---------------------------------------------------------------------------

export interface ReportsTabParams {
  // YYYY-MM-DD inclusive lower bound for range-scoped tabs (cashflow,
  // spending, behavior). Ignored by debt; budget uses monthStart instead.
  fromDate: string;
  toDate: string;
  rangeDays: number;
  // First day of the selected budget month (YYYY-MM-DD), for the budget tab.
  monthStart: string;
}

export interface TabFacts {
  // Stable, narration-free object used to compute the cache hash.
  hashInput: unknown;
  // Human-readable fact lines fed to the LLM.
  lines: string[];
  // Deterministic fallback used when the AI call is unavailable.
  fallbackHeadline: string;
  fallbackBullets: string[];
  // Short label naming what this tab covers, used in the prompt.
  topic: string;
}

async function loadCategoryNames(
  householdId: string,
): Promise<{ names: Map<string, string>; excluded: Set<string> }> {
  const cats = await db
    .select({
      id: budgetCategoriesTable.id,
      name: budgetCategoriesTable.name,
      excludeFromBudget: budgetCategoriesTable.excludeFromBudget,
    })
    .from(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.householdId, householdId));
  const names = new Map<string, string>();
  const excluded = new Set<string>();
  for (const c of cats) {
    names.set(c.id, c.name);
    if (c.excludeFromBudget) excluded.add(c.id);
  }
  return { names, excluded };
}

async function loadRangeTxns(householdId: string, fromDate: string, toDate: string) {
  return db
    .select({
      occurredOn: transactionsTable.occurredOn,
      description: transactionsTable.description,
      amount: transactionsTable.amount,
      categoryId: transactionsTable.categoryId,
      isTransfer: transactionsTable.isTransfer,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        gte(transactionsTable.occurredOn, fromDate),
        lte(transactionsTable.occurredOn, toDate),
      ),
    )
    .orderBy(desc(transactionsTable.occurredOn));
}

// --- Debt tab -------------------------------------------------------------
async function buildDebtFacts(householdId: string, ownerUserId: string): Promise<TabFacts> {
  const debts = await db
    .select({
      name: debtsTable.name,
      balance: debtsTable.balance,
      apr: debtsTable.apr,
      status: debtsTable.status,
      type: debtsTable.type,
    })
    .from(debtsTable)
    .where(eq(debtsTable.householdId, householdId));
  const active = debts.filter((d) => (d.status ?? "active").toLowerCase() === "active");
  const totalDebt = active.reduce((a, d) => a + num(d.balance), 0);
  const schedule = await buildAvalancheSchedule(householdId, ownerUserId);
  const target = schedule.currentAvalancheTarget;
  const sorted = [...active].sort((a, b) => num(b.apr) - num(a.apr));

  const lines: string[] = [];
  lines.push(`Active debts: ${active.length}`);
  lines.push(`Total debt balance: ${money(totalDebt)}`);
  if (target) {
    lines.push(
      `Avalanche target (highest APR): ${target.debtName} at ${(target.apr * 100).toFixed(2)}% APR, balance ${money(target.balance)}`,
    );
  } else {
    lines.push("Avalanche target: none (no active debt with a balance)");
  }
  lines.push(`Planned extra payments over next 12 months: ${money(schedule.totalProposed)} across ${schedule.proposedPayments.length} payments`);
  if (sorted.length > 1) {
    lines.push(
      "Other active debts by APR: " +
        sorted
          .slice(1, 4)
          .map((d) => `${d.name} (${(num(d.apr) * 100).toFixed(2)}%, ${money(num(d.balance))})`)
          .join("; "),
    );
  }

  const fallbackBullets: string[] = [];
  fallbackBullets.push(`You carry ${money(totalDebt)} across ${active.length} active debt${active.length === 1 ? "" : "s"}.`);
  if (target) {
    fallbackBullets.push(
      `The avalanche method attacks ${target.debtName} first — it has the highest rate at ${(target.apr * 100).toFixed(2)}% APR.`,
    );
  }
  if (schedule.proposedPayments.length > 0) {
    fallbackBullets.push(
      `Your plan frees up ${money(schedule.totalProposed)} in extra payments over the next year.`,
    );
  }

  return {
    hashInput: {
      totalDebt,
      count: active.length,
      target,
      totalProposed: schedule.totalProposed,
      payments: schedule.proposedPayments.length,
    },
    lines,
    fallbackHeadline: target
      ? `Focus extra payments on ${target.debtName} — it costs you the most in interest.`
      : `${money(totalDebt)} of debt across ${active.length} account${active.length === 1 ? "" : "s"}.`,
    fallbackBullets,
    topic: "debt payoff progress and the avalanche plan",
  };
}

// --- Cash Flow tab --------------------------------------------------------
async function buildCashFlowFacts(
  householdId: string,
  ownerUserId: string,
  p: ReportsTabParams,
): Promise<TabFacts> {
  const { excluded } = await loadCategoryNames(householdId);
  const txns = await loadRangeTxns(householdId, p.fromDate, p.toDate);
  let income = 0;
  let expense = 0;
  for (const t of txns) {
    if (t.isTransfer) continue;
    const cid = t.categoryId;
    if (cid && excluded.has(cid)) continue; // ignore excluded categories
    const a = num(t.amount);
    if (a > 0) income += a;
    else expense += -a;
  }
  const net = income - expense;
  const signal = await computeCashSignal(householdId, ownerUserId, { horizonDays: 90 });

  const lines: string[] = [];
  lines.push(`Window: last ${p.rangeDays} days (${p.fromDate} to ${p.toDate})`);
  lines.push(`Money in: ${money(income)}`);
  lines.push(`Money out: ${money(expense)}`);
  lines.push(`Net cash flow: ${money(net)} (${net >= 0 ? "surplus" : "deficit"})`);
  lines.push(`Current bank balance: ${money(num(signal.bankToday))}`);
  lines.push(
    `Forward 90-day projection: lowest balance ${money(num(signal.lowestProjected))}` +
      (signal.lowestDate ? ` on ${signal.lowestDate}` : "") +
      `, cash buffer ${money(num(signal.cashBuffer))}, status ${signal.status}`,
  );

  const fallbackBullets: string[] = [];
  fallbackBullets.push(
    `Over the last ${p.rangeDays} days you took in ${money(income)} and spent ${money(expense)}.`,
  );
  fallbackBullets.push(
    net >= 0
      ? `That is a ${money(net)} surplus for the window.`
      : `That is a ${money(-net)} shortfall for the window.`,
  );
  if (signal.status !== "no_data") {
    fallbackBullets.push(
      `Looking 90 days out, your balance bottoms at ${money(num(signal.lowestProjected))}${signal.lowestDate ? ` on ${signal.lowestDate}` : ""}.`,
    );
  }

  return {
    hashInput: {
      from: p.fromDate,
      to: p.toDate,
      income: Math.round(income),
      expense: Math.round(expense),
      net: Math.round(net),
      status: signal.status,
      lowest: Math.round(num(signal.lowestProjected)),
    },
    lines,
    fallbackHeadline:
      net >= 0
        ? `You ran a ${money(net)} surplus over the last ${p.rangeDays} days.`
        : `You spent ${money(-net)} more than you earned over the last ${p.rangeDays} days.`,
    fallbackBullets,
    topic: "cash flow — money in versus money out, and the forward projection",
  };
}

// --- Spending tab ---------------------------------------------------------
// (Phase 2) Reuses the deterministic Spending facts pipeline that powers
// GET /reports/spending-facts so the narrative and the charts agree on the
// exact same numbers (real spend excludes income/transfers/debt/reimbursement,
// merchant names are cleaned, uncategorized backlog is surfaced separately).
// The prompt deliberately LEADS with the uncategorized call-to-action — an
// untagged backlog distorts every other figure — then walks the top
// categories and the merchant patterns underneath them.
async function buildSpendingFacts(
  householdId: string,
  p: ReportsTabParams,
): Promise<TabFacts> {
  const f = await buildSpendingFactsPipeline(householdId, p.fromDate, p.toDate);

  const realTotal = f.realSpend.total;
  const topCats = f.byCategory
    .filter((c) => !/uncategorized/i.test(c.name))
    .slice(0, 5);
  const topMerchants = f.byMerchant.slice(0, 5);
  const hasUncat = f.uncategorized.total > 0 && f.uncategorized.transactionCount > 0;

  const lines: string[] = [];
  lines.push(
    `Window: ${f.range.start} to ${f.range.end} (${f.range.daysCovered} days)${f.range.floorApplied ? " — clamped to the tracking start (May 1, 2026)" : ""}`,
  );
  lines.push(
    `Real spend (excludes income, transfers, debt payments, reimbursements, ignored): ${money(realTotal)} across ${f.realSpend.transactionCount} transactions`,
  );

  // LEAD with the uncategorized backlog — the single most actionable fact.
  if (hasUncat) {
    lines.push(
      `UNCATEGORIZED BACKLOG (call this out first): ${money(f.uncategorized.total)} across ${f.uncategorized.transactionCount} transactions is not yet tagged, so the category picture below is incomplete until it's cleared.`,
    );
    if (f.uncategorized.sampleMerchants.length > 0) {
      const samples = f.uncategorized.sampleMerchants
        .slice(0, 3)
        .map((m) => `${m.name} (${money(m.total)})`)
        .join(", ");
      lines.push(`  Largest untagged merchants: ${samples}`);
    }
  } else {
    lines.push("Everything in this window is categorized — no untagged backlog.");
  }

  lines.push("Top categories (real spend only):");
  topCats.forEach((c, i) =>
    lines.push(
      `  ${i + 1}. ${c.name}: ${money(c.total)} (${pct(c.pctOfRealSpend)} of real spend, ${c.txnCount} txns)`,
    ),
  );

  if (topMerchants.length > 0) {
    lines.push("Top merchants (cleaned names):");
    topMerchants.forEach((m, i) =>
      lines.push(
        `  ${i + 1}. ${m.name}: ${money(m.total)} over ${m.count} visits${m.sampleCategoryName ? ` (usually ${m.sampleCategoryName})` : ""}`,
      ),
    );
  }

  if (f.reimbursable.outstandingReimbursableTotal > 0) {
    lines.push(
      `Outstanding reimbursable on Amex: ${money(f.reimbursable.outstandingReimbursableTotal)} still owed back to the household.`,
    );
  }

  // Deterministic fallback (used when the AI call fails). Same priority:
  // uncategorized first, then the leading category and merchant.
  const fallbackBullets: string[] = [];
  if (hasUncat) {
    fallbackBullets.push(
      `${money(f.uncategorized.total)} across ${f.uncategorized.transactionCount} transactions is still uncategorized — tag it to sharpen these numbers.`,
    );
  }
  fallbackBullets.push(
    `Real spend was ${money(realTotal)} over ${f.range.daysCovered} days.`,
  );
  if (topCats[0]) {
    fallbackBullets.push(
      `Biggest category: ${topCats[0].name} at ${money(topCats[0].total)} (${pct(topCats[0].pctOfRealSpend)} of real spend).`,
    );
  }
  if (topMerchants[0]) {
    fallbackBullets.push(
      `Top merchant: ${topMerchants[0].name} at ${money(topMerchants[0].total)} over ${topMerchants[0].count} visits.`,
    );
  }

  const fallbackHeadline = hasUncat
    ? `${money(f.uncategorized.total)} is still uncategorized — clear it to trust the rest of your spending picture.`
    : topCats[0]
      ? `${topCats[0].name} led your spending at ${money(topCats[0].total)} over ${f.range.daysCovered} days.`
      : `You spent ${money(realTotal)} over ${f.range.daysCovered} days.`;

  return {
    hashInput: {
      from: f.range.start,
      to: f.range.end,
      real: Math.round(realTotal),
      uncategorized: Math.round(f.uncategorized.total),
      uncategorizedCount: f.uncategorized.transactionCount,
      topCats: topCats.map((c) => [c.name, Math.round(c.total)]),
      topMerchants: topMerchants.map((m) => [m.name, Math.round(m.total)]),
    },
    lines,
    fallbackHeadline,
    fallbackBullets,
    topic:
      "where the money went — real spending by category and merchant, plus any uncategorized backlog to clear first",
  };
}

// --- Budget tab -----------------------------------------------------------
async function buildBudgetFacts(
  householdId: string,
  p: ReportsTabParams,
): Promise<TabFacts> {
  const monthStart = p.monthStart;
  const d = new Date(monthStart + "T00:00:00Z");
  const monthEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
    .toISOString()
    .slice(0, 10);

  const lines_ = await db
    .select({
      categoryId: budgetLinesTable.categoryId,
      planned: budgetLinesTable.plannedAmount,
      name: budgetCategoriesTable.name,
      excludeFromBudget: budgetCategoriesTable.excludeFromBudget,
    })
    .from(budgetLinesTable)
    .leftJoin(
      budgetCategoriesTable,
      eq(budgetLinesTable.categoryId, budgetCategoriesTable.id),
    )
    .where(
      and(
        eq(budgetLinesTable.householdId, householdId),
        eq(budgetLinesTable.monthStart, monthStart),
      ),
    );

  // Mirror budget.ts actuals semantics: spend per category, amex-aware sign
  // (amex charges are positive, bank spend is negative), excluding transfers.
  // Avoids the abs(sum) distortion that mixed-sign refunds would cause.
  const actualsRows = await db
    .select({
      categoryId: transactionsTable.categoryId,
      spend: sql<string>`coalesce(sum(case
        when ${transactionsTable.source} = 'amex' and ${transactionsTable.amount} > 0 then ${transactionsTable.amount}
        when ${transactionsTable.source} <> 'amex' and ${transactionsTable.amount} < 0 then -${transactionsTable.amount}
        else 0 end)::text, '0')`,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        gte(transactionsTable.occurredOn, monthStart),
        lte(transactionsTable.occurredOn, monthEnd),
        eq(transactionsTable.isTransfer, false),
      ),
    )
    .groupBy(transactionsTable.categoryId);
  const actualByCat = new Map<string, number>();
  for (const r of actualsRows) {
    if (!r.categoryId) continue;
    actualByCat.set(r.categoryId, num(r.spend));
  }

  let totalPlanned = 0;
  let totalActual = 0;
  const rows = lines_
    .filter((l) => !l.excludeFromBudget)
    .map((l) => {
      const planned = num(l.planned);
      const actual = actualByCat.get(l.categoryId) ?? 0;
      totalPlanned += planned;
      totalActual += actual;
      return { name: l.name ?? "Unknown", planned, actual, over: actual - planned };
    });
  const overspent = rows
    .filter((r) => r.over > 0)
    .sort((a, b) => b.over - a.over)
    .slice(0, 3);

  const lines: string[] = [];
  lines.push(`Budget month: ${monthStart.slice(0, 7)}`);
  lines.push(`Total planned: ${money(totalPlanned)}`);
  lines.push(`Total actual: ${money(totalActual)}`);
  lines.push(
    `Overall: ${totalActual <= totalPlanned ? "under" : "over"} budget by ${money(Math.abs(totalPlanned - totalActual))}`,
  );
  if (overspent.length) {
    lines.push("Most over-budget categories:");
    overspent.forEach((r, i) =>
      lines.push(`  ${i + 1}. ${r.name}: spent ${money(r.actual)} vs planned ${money(r.planned)} (over by ${money(r.over)})`),
    );
  } else {
    lines.push("No categories are over budget this month.");
  }

  const fallbackBullets: string[] = [];
  fallbackBullets.push(
    totalActual <= totalPlanned
      ? `You are under budget by ${money(totalPlanned - totalActual)} this month.`
      : `You are over budget by ${money(totalActual - totalPlanned)} this month.`,
  );
  if (overspent[0]) {
    fallbackBullets.push(
      `${overspent[0].name} is the biggest overspend — ${money(overspent[0].actual)} against a ${money(overspent[0].planned)} plan.`,
    );
  }

  return {
    hashInput: {
      month: monthStart.slice(0, 7),
      totalPlanned: Math.round(totalPlanned),
      totalActual: Math.round(totalActual),
      overspent: overspent.map((r) => [r.name, Math.round(r.over)]),
    },
    lines,
    fallbackHeadline:
      totalActual <= totalPlanned
        ? `You are tracking ${money(totalPlanned - totalActual)} under budget this month.`
        : `You are ${money(totalActual - totalPlanned)} over budget this month.`,
    fallbackBullets,
    topic: "budget plan versus actual spending this month",
  };
}

// --- Behavior tab ---------------------------------------------------------
async function buildBehaviorFacts(
  householdId: string,
  p: ReportsTabParams,
): Promise<TabFacts> {
  const { names, excluded } = await loadCategoryNames(householdId);
  const txns = await loadRangeTxns(householdId, p.fromDate, p.toDate);
  const spends = txns.filter((t) => !t.isTransfer && num(t.amount) < 0);

  let biggest: { description: string; amount: number; date: string } | null = null;
  const dowCount = [0, 0, 0, 0, 0, 0, 0];
  const merchantCount = new Map<string, number>();
  for (const t of spends) {
    const a = -num(t.amount);
    if (!biggest || a > biggest.amount) {
      biggest = { description: t.description, amount: a, date: t.occurredOn };
    }
    const cid = t.categoryId ?? "";
    if (!excluded.has(cid)) {
      const dow = new Date(t.occurredOn + "T00:00:00Z").getUTCDay();
      dowCount[dow] += 1;
    }
    const key = t.description.trim().toLowerCase();
    if (key) merchantCount.set(key, (merchantCount.get(key) ?? 0) + 1);
  }
  const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  let busiestDow = 0;
  for (let i = 1; i < 7; i++) if (dowCount[i] > dowCount[busiestDow]) busiestDow = i;
  const topMerchant = [...merchantCount.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;

  const lines: string[] = [];
  lines.push(`Window: last ${p.rangeDays} days`);
  lines.push(`Total purchases (debits): ${spends.length}`);
  if (biggest) {
    lines.push(`Biggest single purchase: ${money(biggest.amount)} — "${biggest.description}" on ${biggest.date}`);
  }
  lines.push(`Busiest spending day of week: ${DOW[busiestDow]} (${dowCount[busiestDow]} purchases)`);
  if (topMerchant) {
    lines.push(`Most frequent merchant: "${topMerchant[0]}" (${topMerchant[1]} times)`);
  }

  const fallbackBullets: string[] = [];
  if (biggest) {
    fallbackBullets.push(`Your largest purchase was ${money(biggest.amount)} on "${biggest.description}".`);
  }
  fallbackBullets.push(`${DOW[busiestDow]} is your busiest spending day.`);
  if (topMerchant) {
    fallbackBullets.push(`You visited "${topMerchant[0]}" ${topMerchant[1]} times in this window.`);
  }

  return {
    hashInput: {
      from: p.fromDate,
      to: p.toDate,
      count: spends.length,
      biggest: biggest ? [biggest.description, Math.round(biggest.amount), biggest.date] : null,
      busiestDow,
      topMerchant: topMerchant ? [topMerchant[0], topMerchant[1]] : null,
    },
    lines,
    fallbackHeadline: biggest
      ? `${DOW[busiestDow]} is your busiest spending day, and "${biggest.description}" was your biggest hit.`
      : `${DOW[busiestDow]} is your busiest spending day.`,
    fallbackBullets,
    topic: "spending behavior and habits — fun patterns in how you spend",
  };
}

export async function buildTabFacts(
  tab: ReportsAdvisorTab,
  householdId: string,
  ownerUserId: string,
  p: ReportsTabParams,
): Promise<TabFacts> {
  switch (tab) {
    case "debt":
      return buildDebtFacts(householdId, ownerUserId);
    case "cashflow":
      return buildCashFlowFacts(householdId, ownerUserId, p);
    case "spending":
      return buildSpendingFacts(householdId, p);
    case "budget":
      return buildBudgetFacts(householdId, p);
    case "behavior":
      return buildBehaviorFacts(householdId, p);
  }
}

// ---------------------------------------------------------------------------
// LLM call + fallback
// ---------------------------------------------------------------------------

function systemPrompt(topic: string): string {
  return `You write a short, concrete narrative for one tab of a household budgeting app's Reports page. This tab is about: ${topic}.

The app has already computed deterministic FACTS. Your job is ONLY to narrate them in plain language.

Output requirements:
- Respond with ONLY a JSON object, no markdown fence, no preamble.
- Schema: {"headline": string, "bullets": string[]}
- headline: ONE direct sentence — the single most important takeaway.
- bullets: 2 to 4 short, concrete observations. Each references REAL numbers from the FACTS only.

Style:
- Direct, non-judgmental, concrete. The user is technical and dislikes filler.
- Whole dollars only (no cents).
- NEVER invent numbers, dates, names, or categories. Only use values present in the FACTS block.`;
}

interface ParsedLLM {
  headline: string;
  bullets: string[];
}

function parseLLM(raw: string): ParsedLLM | null {
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
  const o = parsed as Record<string, unknown>;
  const headline = typeof o.headline === "string" ? o.headline.trim() : "";
  const bullets = Array.isArray(o.bullets)
    ? o.bullets.filter((b): b is string => typeof b === "string" && b.trim().length > 0)
    : [];
  if (!headline || bullets.length === 0) return null;
  return { headline, bullets };
}

async function callAnthropic(facts: TabFacts): Promise<ParsedLLM | null> {
  const client = getClient();
  if (!client) return null;
  const userPrompt = `FACTS:\n${facts.lines.join("\n")}\n\nWrite the JSON now.`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ANTHROPIC_TIMEOUT_MS);
  try {
    const res = await client.messages.create(
      {
        model: getModel(),
        max_tokens: MAX_OUTPUT_TOKENS,
        system: systemPrompt(facts.topic),
        messages: [{ role: "user", content: userPrompt }],
      },
      { signal: ctrl.signal },
    );
    const block = res.content.find((c) => c.type === "text");
    if (!block || block.type !== "text") return null;
    return parseLLM(block.text);
  } finally {
    clearTimeout(timer);
  }
}

export function buildFallback(
  tab: ReportsAdvisorTab,
  facts: TabFacts,
): ReportsAdvisorSummary {
  return {
    generatedAt: new Date().toISOString(),
    tab,
    headline: facts.fallbackHeadline,
    bullets: facts.fallbackBullets.length ? facts.fallbackBullets : [facts.fallbackHeadline],
    source: "fallback",
  };
}

/**
 * Generate (not persist) the narrative for one tab from its deterministic
 * facts. Three-layer fallback identical to the Avalanche advisor:
 *   1. AI call -> usable JSON -> source "ai".
 *   2. Timeout / parse failure / no client -> deterministic template.
 *   3. Outer exception -> minimal summary from the fallback headline.
 */
export async function generateReportsTabSummary(
  tab: ReportsAdvisorTab,
  facts: TabFacts,
): Promise<ReportsAdvisorSummary> {
  try {
    const llm = await callAnthropic(facts);
    if (llm) {
      return {
        generatedAt: new Date().toISOString(),
        tab,
        headline: llm.headline,
        bullets: llm.bullets,
        source: "ai",
      };
    }
    logger.warn({ tab }, "reports-advisor: LLM returned no usable summary, using fallback");
  } catch (err) {
    logger.warn(
      { tab, err: err instanceof Error ? err.message : String(err) },
      "reports-advisor: LLM call failed, using fallback",
    );
  }
  try {
    return buildFallback(tab, facts);
  } catch (err) {
    logger.warn(
      { tab, err: err instanceof Error ? err.message : String(err) },
      "reports-advisor: fallback template failed, using minimal summary",
    );
    return {
      generatedAt: new Date().toISOString(),
      tab,
      headline: facts.fallbackHeadline || "Summary unavailable.",
      bullets: [facts.fallbackHeadline || "Summary unavailable."],
      source: "fallback",
    };
  }
}
