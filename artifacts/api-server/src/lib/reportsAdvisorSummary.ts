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
import { buildBehaviorFacts as buildBehaviorFactsPipeline } from "./behaviorFacts";
import { buildBudgetFacts as buildBudgetFactsPipeline } from "./budgetFacts";

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
  // Optional per-tab system prompt. When set, it replaces the default
  // systemPrompt(topic) — used by the Behavior tab for a warmer voice.
  systemPromptOverride?: string;
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
// (#854 Phase 2) Narrate the clean, class-aware budgetFacts pipeline like a
// friend checking in. Income and paid bills are NEVER framed as "over budget"
// — a paycheck landing at 152% is good, a mortgage at 100% is paid. The only
// thing that can run "hot" is flex (day-to-day) spending.
async function buildBudgetFacts(
  householdId: string,
  p: ReportsTabParams,
): Promise<TabFacts> {
  const f = await buildBudgetFactsPipeline(householdId, p.monthStart, 6);
  const { range, income, bills, debts, flex } = f;

  const sumActual = (ls: { actual: number }[]) =>
    ls.reduce((s, l) => s + l.actual, 0);
  const sumPlanned = (ls: { planned: number }[]) =>
    ls.reduce((s, l) => s + l.planned, 0);

  // Income (paychecks) — "landed" = status good; expected = planned > 0.
  const incomeActual = sumActual(income.lines);
  const incomePlanned = sumPlanned(income.lines);
  const paychecksLanded = income.paidCount;
  const paychecksExpected = income.lines.filter((l) => l.planned > 0).length;

  // Bills + loans merged — paid = status good.
  const fixedLines = [...bills.lines, ...debts.lines];
  const paidCount = bills.paidCount + debts.paidCount;
  const totalCount = bills.totalCount + debts.totalCount;
  const fixedActual = sumActual(fixedLines);
  const fixedPlanned = sumPlanned(fixedLines);
  const paidNames = fixedLines
    .filter((l) => l.status === "good")
    .sort((a, b) => b.actual - a.actual)
    .map((l) => l.name);

  // Flex — the only class that can run hot.
  const hotFlex =
    flex.lines.find((l) => l.status !== "good") ?? flex.lines[0] ?? null;

  const nothingSet =
    income.totalCount === 0 &&
    totalCount === 0 &&
    flex.totalCount === 0;

  const lines: string[] = [];
  lines.push(
    `Budget month: ${range.monthLabel} — day ${range.daysElapsed} of ${range.daysInMonth}${range.monthHasPassed ? " (month complete)" : ""}`,
  );

  if (nothingSet) {
    lines.push("No budget has been set for this month yet.");
  } else {
    // Income
    lines.push(
      `Paychecks (income): ${paychecksLanded} of ${paychecksExpected} landed — ${money(incomeActual)} in of ${money(incomePlanned)} expected. A paycheck over its estimate is GOOD, never over budget.`,
    );
    income.lines.forEach((l) =>
      lines.push(
        `  - ${l.name}: ${money(l.actual)} in vs ${money(l.planned)} expected (${l.status === "good" ? (l.actual > l.planned ? "ahead" : "on track") : "still expected"})`,
      ),
    );
    // Bills + loans
    lines.push(
      `Bills & loans: ${paidCount} of ${totalCount} paid — ${money(fixedActual)} of ${money(fixedPlanned)}. A bill or loan at 100% is PAID, never over budget.`,
    );
    if (paidNames.length) {
      lines.push(`  Paid so far: ${paidNames.join(", ")}`);
    }
    const stillExpected = fixedLines
      .filter((l) => l.status !== "good")
      .map((l) => l.name);
    if (stillExpected.length) {
      lines.push(`  Still expected: ${stillExpected.join(", ")}`);
    }
    // Flex
    lines.push(
      `Day-to-day (flex) spending: ${money(flex.actualTotal)} of ${money(flex.plannedTotal)} planned, pacing ${flex.paceStatus.replace("_", " ")}.`,
    );
    lines.push(
      `At today's pace, ${range.monthLabel} projects to about ${money(flex.projectedMonthEnd)} flex — ${money(Math.abs(flex.projectedVsPlan))} ${flex.projectedVsPlan >= 0 ? "over" : "under"} plan.`,
    );
    flex.lines.slice(0, 5).forEach((l) =>
      lines.push(
        `  - ${l.name}: ${money(l.actual)}${l.unbudgeted ? " (no budget set)" : ` of ${money(l.planned)} (${pct(l.pct)})`} — ${l.status === "good" ? "on track" : l.status === "watch" ? "watch" : "over"}`,
      ),
    );
  }

  // Deterministic fallback — class-aware. Leads with income + bills, then the
  // single hottest flex overrun. NEVER an income-polluted "over budget by $X".
  const fallbackBullets: string[] = [];
  if (nothingSet) {
    fallbackBullets.push("No budget is set for this month yet.");
  } else {
    fallbackBullets.push(
      `${paychecksLanded} of ${paychecksExpected} paychecks are in — ${money(incomeActual)} of ${money(incomePlanned)} expected.`,
    );
    fallbackBullets.push(
      `${paidCount} of ${totalCount} bills & loans paid (${money(fixedActual)} of ${money(fixedPlanned)}).`,
    );
    fallbackBullets.push(
      `Day-to-day spending is ${money(flex.actualTotal)} of ${money(flex.plannedTotal)}, pacing ${flex.paceStatus.replace("_", " ")}.`,
    );
    if (hotFlex && hotFlex.status !== "good") {
      fallbackBullets.push(
        hotFlex.unbudgeted
          ? `${hotFlex.name} is running hot — ${money(hotFlex.actual)} spent with no budget set.`
          : `${hotFlex.name} is the one running hot at ${pct(hotFlex.pct)} of plan.`,
      );
    }
  }

  const fallbackHeadline = nothingSet
    ? `Brad — no budget set for ${range.monthLabel} yet.`
    : `Brad — ${paychecksLanded} of ${paychecksExpected} paychecks landed (~${money(incomeActual)} in), and ${paidCount} of ${totalCount} bills & loans are paid.`;

  return {
    hashInput: {
      month: range.monthStart,
      paychecks: [paychecksLanded, paychecksExpected, Math.round(incomeActual)],
      bills: [paidCount, totalCount, Math.round(fixedActual)],
      flex: [
        Math.round(flex.actualTotal),
        Math.round(flex.plannedTotal),
        flex.paceStatus,
      ],
      hotFlex: hotFlex ? [hotFlex.name, hotFlex.pct, hotFlex.status] : null,
    },
    lines,
    fallbackHeadline,
    fallbackBullets,
    topic: "this month's budget — paychecks in, bills paid, and day-to-day spending pace",
    systemPromptOverride: budgetSystemPrompt(),
  };
}

function budgetSystemPrompt(): string {
  return `You are checking in with Brad about his household's budget this month — like a friend who glanced at his numbers, NOT an analytics report.

The app has already computed deterministic, class-aware FACTS. Your job is ONLY to narrate them warmly and accurately.

Output requirements:
- Respond with ONLY a JSON object, no markdown fence, no preamble.
- Schema: {"headline": string, "bullets": string[]}
- headline: ONE warm opening line addressed to Brad, leading with paychecks landed and bills paid.
- bullets: 2 to 4 short, friendly observations (3-5 sentences total). Each references REAL numbers from the FACTS only.

Critical framing rules:
- NEVER call income (paychecks) "over budget". A paycheck landing above its estimate is GOOD — say "ahead" or "on track", never a problem.
- NEVER call a paid bill or loan "over budget". A bill at 100% is simply PAID.
- The ONLY thing that can run "hot" or "over" is day-to-day (flex) spending. If something is running hot, name the single hottest flex category and its % of plan.
- Lead with the good: paychecks in, bills paid. Then mention flex pace and the hottest flex category if any.

Style:
- Sound like a friend checking in: warm, specific, encouraging. Use Brad's name.
- Whole dollars only (no cents).
- NEVER invent or guess numbers, names, or percentages. If a fact isn't in the FACTS block, don't mention it.`;
}

// --- Behavior tab ---------------------------------------------------------
// (#851 Phase 2) Narrate the clean behaviorFacts pipeline in a warm,
// friend-texting voice. Reads ONLY from funFacts / daysSinceLast / streaks —
// transfers and ignore rows are already excluded upstream, so the prose can
// never surface "Online Transfer to SAV…" as a splurge.
async function buildBehaviorFacts(
  householdId: string,
  p: ReportsTabParams,
): Promise<TabFacts> {
  const f = await buildBehaviorFactsPipeline(householdId, p.fromDate, p.toDate);
  const { funFacts, daysSinceLast, streaks } = f;

  const lines: string[] = [];
  lines.push(
    `Window: ${f.range.start} to ${f.range.end} (${f.range.daysCovered} days)${f.range.floorApplied ? " — clamped to the tracking start (May 1, 2026)" : ""}`,
  );

  if (funFacts.biggestSplurge) {
    const s = funFacts.biggestSplurge;
    lines.push(
      `Biggest splurge: ${money(s.amount)} at ${s.merchant} on ${s.date}${s.categoryName ? ` (${s.categoryName})` : ""}`,
    );
  }
  if (funFacts.mostVisitedMerchant) {
    const m = funFacts.mostVisitedMerchant;
    lines.push(
      `Most-visited spot: ${m.name} — ${m.count} visits, ${money(m.total)} total`,
    );
  }
  if (daysSinceLast.dining) {
    const d = daysSinceLast.dining;
    lines.push(
      `Days since last dining out: ${d.days} (last was ${d.lastMerchant} on ${d.lastDate})`,
    );
  }
  if (daysSinceLast.coffee) {
    const d = daysSinceLast.coffee;
    lines.push(
      `Days since last coffee run: ${d.days} (last was ${d.lastMerchant} on ${d.lastDate})`,
    );
  }
  if (daysSinceLast.amazon) {
    const d = daysSinceLast.amazon;
    lines.push(
      `Days since last Amazon order: ${d.days} (last was ${d.lastMerchant} on ${d.lastDate})`,
    );
  }
  lines.push(
    `No-dining streak: ${streaks.noDining.currentDays} days right now (longest ever ${streaks.noDining.longestDays})`,
  );
  lines.push(
    `Coffee-free streak: ${streaks.coffeeFree.currentDays} days right now (longest ever ${streaks.coffeeFree.longestDays})`,
  );
  if (funFacts.quietestDay) {
    const q = funFacts.quietestDay;
    lines.push(
      `Quietest spending day: ${q.dayOfWeek} ${q.date}, only ${money(q.total)} out`,
    );
  }
  if (funFacts.impulseBuyCount.count > 0) {
    const i = funFacts.impulseBuyCount;
    lines.push(
      `Impulse buys (small, non-essential): ${i.count} totaling ${money(i.total)}${i.exampleMerchants.length ? ` (e.g. ${i.exampleMerchants.join(", ")})` : ""}`,
    );
  }
  if (funFacts.subscriptionsCount.count > 0) {
    lines.push(
      `Active subscriptions: ${funFacts.subscriptionsCount.count} costing about ${money(funFacts.subscriptionsCount.monthlyTotal)}/mo`,
    );
  }
  if (funFacts.nextPaycheckCountdown) {
    const np = funFacts.nextPaycheckCountdown;
    lines.push(
      `Next paycheck: ${np.paycheckLabel} — ${money(np.expectedAmount)} landing in ${np.days} days (${np.expectedDate})`,
    );
  }

  // Deterministic fallback (warm voice, used when the AI call fails).
  const fallbackBullets: string[] = [];
  if (funFacts.biggestSplurge) {
    const s = funFacts.biggestSplurge;
    fallbackBullets.push(
      `Biggest splurge was ${money(s.amount)} at ${s.merchant} on ${s.date}.`,
    );
  }
  if (funFacts.mostVisitedMerchant) {
    const m = funFacts.mostVisitedMerchant;
    fallbackBullets.push(`You hit ${m.name} ${m.count} times this window.`);
  }
  if (streaks.noDining.currentDays > 0) {
    fallbackBullets.push(
      `You're ${streaks.noDining.currentDays} days into a no-dining streak (longest ${streaks.noDining.longestDays}).`,
    );
  }
  if (funFacts.nextPaycheckCountdown) {
    fallbackBullets.push(
      `Next paycheck lands in ${funFacts.nextPaycheckCountdown.days} days.`,
    );
  }
  if (fallbackBullets.length === 0) {
    fallbackBullets.push(
      "Not much activity in this window yet — patterns will show up as more comes in.",
    );
  }

  const fallbackHeadline = funFacts.biggestSplurge
    ? `Brad — your biggest hit this window was ${money(funFacts.biggestSplurge.amount)} at ${funFacts.biggestSplurge.merchant}.`
    : "Brad — here's how your habits looked this window.";

  return {
    hashInput: {
      from: f.range.start,
      to: f.range.end,
      splurge: funFacts.biggestSplurge
        ? [
            funFacts.biggestSplurge.merchant,
            Math.round(funFacts.biggestSplurge.amount),
            funFacts.biggestSplurge.date,
          ]
        : null,
      mostVisited: funFacts.mostVisitedMerchant
        ? [funFacts.mostVisitedMerchant.name, funFacts.mostVisitedMerchant.count]
        : null,
      noDining: streaks.noDining.currentDays,
      coffeeFree: streaks.coffeeFree.currentDays,
      diningDays: daysSinceLast.dining?.days ?? null,
      coffeeDays: daysSinceLast.coffee?.days ?? null,
      nextPaycheck: funFacts.nextPaycheckCountdown?.days ?? null,
    },
    lines,
    fallbackHeadline,
    fallbackBullets,
    topic: "spending habits and fun behavioral patterns",
    systemPromptOverride: behaviorSystemPrompt(),
  };
}

function behaviorSystemPrompt(): string {
  return `You are writing a few warm, personal observations about Brad's spending habits — like a friend texting him after a glance at his month, NOT an analytics report.

The app has already computed deterministic FACTS. Your job is ONLY to narrate them warmly.

Output requirements:
- Respond with ONLY a JSON object, no markdown fence, no preamble.
- Schema: {"headline": string, "bullets": string[]}
- headline: ONE warm, personal opening line addressed to Brad.
- bullets: 2 to 4 short, friendly observations (3-5 sentences total across them). Each references REAL numbers, merchants, and dates from the FACTS only.

Style:
- Sound like a friend texting: warm, personal, specific. Use Brad's name.
- Name real merchants, real dates, and real dollar amounts straight from the FACTS.
- Whole dollars only (no cents).
- NEVER invent or guess numbers, dates, names, or categories. If a fact isn't in the FACTS block, don't mention it.`;
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
        system: facts.systemPromptOverride ?? systemPrompt(facts.topic),
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
