// Banking insights — Claude captions for the four /banking insight buckets:
//   ✅ goingWell    — categories under budget, spend down vs last month, streaks
//   ⚠️ couldImprove — categories over budget, the biggest overspends
//   🚫 cancelThese  — recurring subscription-looking charges detected in spend
//   💸 notInBudget  — recurring charges NOT set up as bills + unbudgeted spend
//
// Follows avalancheAdvisorSummary.ts / reportsAdvisorSummary.ts exactly:
// same Anthropic client setup, same 12s AbortController timeout, same
// 3-layer fallback (AI call → deterministic template → minimal captions).
//
// EVERY number below is computed deterministically in this file (or by
// budgetFacts.ts) and handed to the model as structured facts. Claude only
// writes the headline + one-liner per bucket — it never does arithmetic.
//
// Model note: this summary runs on Claude Fable 5 (its own DEFAULT_MODEL —
// deliberately NOT the shared ADVISOR_MODEL override, so the global env var
// can't silently downgrade it). Fable 5 is adaptive-thinking-only: we omit
// the `thinking` param entirely and send no temperature — the same call
// shape the other summary modules use, just with the fable-5 model id.

import Anthropic from "@anthropic-ai/sdk";
import { db, transactionsTable, recurringItemsTable } from "@workspace/db";
import { and, eq, gte, lt } from "drizzle-orm";
import { logger } from "./logger";
import { VOICE_SYSTEM } from "./advisorVoice";
import { buildBudgetFacts } from "./budgetFacts";

const DEFAULT_MODEL = "claude-fable-5";
const MAX_OUTPUT_TOKENS = 700;
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
  // Own override knob on purpose — the shared ADVISOR_MODEL env var pins the
  // OTHER summaries; this one stays on Fable 5 unless explicitly overridden.
  return process.env.BANKING_ADVISOR_MODEL || DEFAULT_MODEL;
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

export interface BankingInsightsFacts {
  monthLabel: string;
  daysElapsed: number;
  daysInMonth: number;
  goingWell: {
    underBudget: { name: string; planned: number; actual: number; left: number }[];
    momCur: number;
    momLast: number;
    momDeltaPct: number | null; // negative = spending LESS than last month at the same point
    streaks: { name: string; months: number }[];
  };
  couldImprove: {
    overBudget: { name: string; planned: number; actual: number; over: number }[];
    totalOver: number;
  };
  cancelThese: {
    subs: { merchant: string; typical: number; monthly: number; annual: number; count: number }[];
    totalAnnual: number;
  };
  notInBudget: {
    untrackedRecurring: { merchant: string; monthly: number; annual: number }[];
    unbudgetedCategories: { name: string; actual: number }[];
    totalMonthly: number;
  };
  /** Narration-relevant subset used for the cache hash. */
  hashInput: unknown;
}

// Recurring charges that are bills/debt/life expenses — not consumer
// subscriptions (trimmed version of the client detector's exclusion list;
// this server copy only grounds the caption, the client renders its own
// full detection).
const NOT_A_SUBSCRIPTION =
  /loan|mortgage|heloc|lending|leasing|\blease\b|servicing|credit\s*union|payroll|insur|utilit|electric|\bwater\b|sewer|tuition|univ|college|\btax(es)?\b|\bhoa\b|escrow|\brent\b|car\s*payment|card\s*payment|verizon|at&t|t-?mobile|comcast|xfinity|spectrum|cricket|kwik\s*trip|casey|speedway|shell|exxon|mobil|chevron|marathon|\bbp\b|holiday\s*station|grocer|kroger|aldi|costco|hy-?vee|woodman|metro\s*market|festival\s*foods|pick\s*n\s*save|walmart|target|\bach\b|autopay|transfer|wells\s*fargo|capital\s*one|\bdiscover\b|synchrony|barclays|comenity|navient|nelnet|sofi|venmo|paypal|zelle|cash\s*app/i;

function normalizeMerchant(raw: string): string {
  let s = raw.toLowerCase().trim();
  s = s.replace(/\*+\s*\w+/g, " ");
  s = s.replace(/#?\s*\d[\d\-*]*\s*$/g, " ");
  s = s.replace(/\b(inc|llc|ltd|co|corp|usa|com|net|org|the)\b\.?/g, " ");
  s = s.replace(/[^a-z0-9 ]+/g, " ");
  s = s.replace(/\s{2,}/g, " ").trim();
  return s;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

interface DetectedRecurring {
  merchant: string;
  normalized: string;
  typical: number;
  perYear: number;
  monthly: number;
  annual: number;
  count: number;
}

/**
 * Compact server-side recurring detector: same merchant, near-constant
 * amount, regular cadence over the last ~200 days. Deterministic —
 * mirrors the spirit of the client's detectSubscriptionsFromTransactions
 * (which drives the on-page lists) closely enough to caption them.
 */
function detectRecurring(
  txns: { occurredOn: string; description: string | null; amount: string; source: string | null }[],
): DetectedRecurring[] {
  const groups = new Map<string, { dates: string[]; amounts: number[]; name: string }>();
  for (const t of txns) {
    const raw = Number(t.amount) || 0;
    // Spend convention matches budgetFacts: amex positive = spend,
    // everything else negative = spend.
    const spend = t.source === "amex" ? (raw > 0 ? raw : 0) : raw < 0 ? -raw : 0;
    if (spend <= 0) continue;
    const name = (t.description || "").trim();
    if (!name || NOT_A_SUBSCRIPTION.test(name)) continue;
    const key = normalizeMerchant(name);
    if (!key) continue;
    const g = groups.get(key) ?? { dates: [], amounts: [], name };
    g.dates.push(t.occurredOn.slice(0, 10));
    g.amounts.push(spend);
    groups.set(key, g);
  }

  const out: DetectedRecurring[] = [];
  for (const [key, g] of groups) {
    // Same-day dedupe, then need ≥3 charges to call it recurring.
    const dates = [...new Set(g.dates)].sort();
    if (dates.length < 3) continue;
    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i++) {
      gaps.push(
        (new Date(`${dates[i]}T00:00:00Z`).getTime() -
          new Date(`${dates[i - 1]}T00:00:00Z`).getTime()) /
          86_400_000,
      );
    }
    const gap = median(gaps);
    let perYear: number | null = null;
    if (gap >= 5 && gap <= 9) perYear = 52;
    else if (gap >= 12 && gap <= 18) perYear = 26;
    else if (gap >= 25 && gap <= 38) perYear = 12;
    else if (gap >= 55 && gap <= 70) perYear = 6;
    else if (gap >= 80 && gap <= 100) perYear = 4;
    if (perYear == null) continue;
    const typical = median(g.amounts);
    // Near-constant amount: max deviation from the median within 25%.
    const varies = g.amounts.some((a) => Math.abs(a - typical) > typical * 0.25);
    if (varies) continue;
    const annual = round2(typical * perYear);
    out.push({
      merchant: g.name,
      normalized: key,
      typical: round2(typical),
      perYear,
      monthly: round2(annual / 12),
      annual,
      count: dates.length,
    });
  }
  return out.sort((a, b) => b.annual - a.annual);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function buildBankingInsightsFacts(
  householdId: string,
): Promise<BankingInsightsFacts> {
  const today = new Date();
  const todayIso = isoDate(today);
  const monthStart = isoDate(
    new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)),
  );
  const prevMonthStart = isoDate(
    new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)),
  );

  // Budget plan-vs-actual per category — the SAME deterministic pipeline the
  // Reports budget tab uses (budgetFacts.ts).
  const budget = await buildBudgetFacts(householdId, monthStart, 6);
  const expenseLines = [
    ...budget.bills.lines,
    ...budget.debts.lines,
    ...budget.flex.lines,
  ];

  const underBudget = expenseLines
    .filter((l) => l.planned > 0 && l.actual < l.planned)
    .map((l) => ({
      name: l.name,
      planned: round2(l.planned),
      actual: round2(l.actual),
      left: round2(l.planned - l.actual),
    }))
    .sort((a, b) => b.left - a.left)
    .slice(0, 5);

  const overBudget = expenseLines
    .filter((l) => l.planned > 0 && l.actual > l.planned)
    .map((l) => ({
      name: l.name,
      planned: round2(l.planned),
      actual: round2(l.actual),
      over: round2(l.actual - l.planned),
    }))
    .sort((a, b) => b.over - a.over)
    .slice(0, 5);
  const totalOver = round2(overBudget.reduce((s, l) => s + l.over, 0));

  const unbudgetedCategories = budget.flex.lines
    .filter((l) => l.unbudgeted)
    .map((l) => ({ name: l.name, actual: round2(l.actual) }))
    .sort((a, b) => b.actual - a.actual)
    .slice(0, 5);

  const streaks = budget.streak.rows
    .filter((r) => r.class !== "income" && r.currentStreakGood >= 2)
    .sort((a, b) => b.currentStreakGood - a.currentStreakGood)
    .slice(0, 3)
    .map((r) => ({ name: r.name, months: r.currentStreakGood }));

  // Month-over-month spend at the same point in the month — one scoped
  // query covering last month start → today, aggregated in code.
  const momRows = await db
    .select({
      occurredOn: transactionsTable.occurredOn,
      amount: transactionsTable.amount,
      source: transactionsTable.source,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        gte(transactionsTable.occurredOn, prevMonthStart),
        eq(transactionsTable.isTransfer, false),
      ),
    );
  const dayOfMonth = today.getUTCDate();
  let momCur = 0;
  let momLast = 0;
  for (const t of momRows) {
    const raw = Number(t.amount) || 0;
    const spend = t.source === "amex" ? (raw > 0 ? raw : 0) : raw < 0 ? -raw : 0;
    if (spend <= 0) continue;
    const day = Number(t.occurredOn.slice(8, 10));
    if (t.occurredOn >= monthStart) momCur += spend;
    else if (day <= dayOfMonth) momLast += spend;
  }
  momCur = round2(momCur);
  momLast = round2(momLast);
  const momDeltaPct =
    momLast > 0 ? Math.round(((momCur - momLast) / momLast) * 100) : null;

  // Recurring detection over the last ~200 days (scoped query, no
  // unbounded fetch), plus the tracked recurring-item names so we can tell
  // "already a bill" from "paying for it but never set it up".
  const from200 = isoDate(new Date(today.getTime() - 200 * 86_400_000));
  const recentTxns = await db
    .select({
      occurredOn: transactionsTable.occurredOn,
      description: transactionsTable.description,
      amount: transactionsTable.amount,
      source: transactionsTable.source,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        gte(transactionsTable.occurredOn, from200),
        lt(transactionsTable.occurredOn, isoDate(new Date(today.getTime() + 86_400_000))),
        eq(transactionsTable.isTransfer, false),
      ),
    );
  const detected = detectRecurring(recentTxns);

  const recurringItems = await db
    .select({ name: recurringItemsTable.name, active: recurringItemsTable.active })
    .from(recurringItemsTable)
    .where(eq(recurringItemsTable.householdId, householdId));
  const trackedNames = new Set(
    recurringItems
      .filter((r) => r.active !== "false")
      .map((r) => normalizeMerchant(r.name)),
  );

  const subs = detected.slice(0, 6).map((d) => ({
    merchant: d.merchant,
    typical: d.typical,
    monthly: d.monthly,
    annual: d.annual,
    count: d.count,
  }));
  const totalAnnual = round2(detected.reduce((s, d) => s + d.annual, 0));

  const untrackedRecurring = detected
    .filter((d) => !trackedNames.has(d.normalized))
    .slice(0, 6)
    .map((d) => ({ merchant: d.merchant, monthly: d.monthly, annual: d.annual }));
  // Monthly total covers the untracked recurring charges only — unbudgeted
  // categories are one-month actuals, not a monthly bill, so they aren't
  // blended into this figure.
  const totalMonthly = round2(
    untrackedRecurring.reduce((s, d) => s + d.monthly, 0),
  );

  const facts: BankingInsightsFacts = {
    monthLabel: budget.range.monthLabel,
    daysElapsed: budget.range.daysElapsed,
    daysInMonth: budget.range.daysInMonth,
    goingWell: { underBudget, momCur, momLast, momDeltaPct, streaks },
    couldImprove: { overBudget, totalOver },
    cancelThese: { subs, totalAnnual },
    notInBudget: { untrackedRecurring, unbudgetedCategories, totalMonthly },
    hashInput: null,
  };
  facts.hashInput = {
    m: facts.monthLabel,
    gw: { u: underBudget, d: momDeltaPct, s: streaks },
    ci: { o: overBudget, t: totalOver },
    ct: { s: subs, t: totalAnnual },
    nb: { r: untrackedRecurring, c: unbudgetedCategories },
  };
  return facts;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `${VOICE_SYSTEM}

TASK: Caption the four insight buckets on the household budget app's Banking page. The app has already computed every number deterministically; the bucket item lists render from code. You write ONE short headline + ONE punchy one-line caption per bucket. Narrate the facts — never compute, never invent.

Output requirements:
- Respond with ONLY a JSON object, no markdown fence, no preamble.
- Schema: {"goingWell": {"headline": string, "caption": string}, "couldImprove": {...}, "cancelThese": {...}, "notInBudget": {...}}
- headline: ≤ 8 words, hits hard.
- caption: ONE sentence, ≤ 25 words. Reference real names/amounts from the FACTS only.
- goingWell: acknowledge what's genuinely working (under-budget categories, spend down vs the same point last month, streaks) and reinforce it. If nothing's working yet, say so plainly.
- couldImprove: name the biggest over-budget categories by name and dollar, and point at the fix.
- cancelThese: the recurring subscriptions worth cancelling — recommend cancelling and redirecting the money to the payoff plan.
- notInBudget: recurring charges they pay but never budgeted for, plus categories with spend and no budget line — suggest adding them to the plan.

Rules:
- Whole dollars only (no cents).
- Be time-aware: it may be early in the month — frame partial-month numbers as "so far / on pace," never a partial period against a full one.
- NEVER invent numbers, names, or dates — only values in the FACTS block. The figures are provided; never alter them.
- If a bucket's facts are empty, write an honest one-liner saying it's clean (or that there's nothing to show yet).`;

function formatFactsForPrompt(f: BankingInsightsFacts): string {
  const lines: string[] = [];
  lines.push(`MONTH: ${f.monthLabel} (day ${f.daysElapsed} of ${f.daysInMonth})`);
  lines.push("");
  lines.push("GOING WELL:");
  if (f.goingWell.underBudget.length === 0) lines.push("  Under-budget categories: none");
  for (const l of f.goingWell.underBudget)
    lines.push(`  UNDER budget: ${l.name} — spent ${money(l.actual)} of ${money(l.planned)} (${money(l.left)} left)`);
  if (f.goingWell.momDeltaPct != null)
    lines.push(
      `  Spend vs last month at the same point: ${money(f.goingWell.momCur)} now vs ${money(f.goingWell.momLast)} then (${f.goingWell.momDeltaPct > 0 ? "+" : ""}${f.goingWell.momDeltaPct}%)`,
    );
  for (const s of f.goingWell.streaks)
    lines.push(`  Streak: ${s.name} on budget ${s.months} months running`);
  lines.push("");
  lines.push("COULD IMPROVE:");
  if (f.couldImprove.overBudget.length === 0) lines.push("  Over-budget categories: none");
  for (const l of f.couldImprove.overBudget)
    lines.push(`  OVER budget: ${l.name} — spent ${money(l.actual)} against ${money(l.planned)} (${money(l.over)} over)`);
  if (f.couldImprove.totalOver > 0)
    lines.push(`  Total overspend across listed categories: ${money(f.couldImprove.totalOver)}`);
  lines.push("");
  lines.push("CANCEL THESE (detected recurring subscriptions):");
  if (f.cancelThese.subs.length === 0) lines.push("  none detected");
  for (const s of f.cancelThese.subs)
    lines.push(`  ${s.merchant}: ${money(s.typical)} per charge, ~${money(s.monthly)}/mo, ${money(s.annual)}/yr (${s.count} charges)`);
  if (f.cancelThese.totalAnnual > 0)
    lines.push(`  Total detected subscription burn: ${money(f.cancelThese.totalAnnual)}/yr`);
  lines.push("");
  lines.push("PAYING FOR, NOT IN THE BUDGET:");
  if (
    f.notInBudget.untrackedRecurring.length === 0 &&
    f.notInBudget.unbudgetedCategories.length === 0
  )
    lines.push("  none — everything recurring is tracked and budgeted");
  for (const r of f.notInBudget.untrackedRecurring)
    lines.push(`  Recurring but NOT set up as a bill: ${r.merchant} — ~${money(r.monthly)}/mo (${money(r.annual)}/yr)`);
  for (const c of f.notInBudget.unbudgetedCategories)
    lines.push(`  Spend with NO budget line: ${c.name} — ${money(c.actual)} this month`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// LLM response parsing
// ---------------------------------------------------------------------------

export interface BankingBucketCaption {
  headline: string;
  caption: string;
}
export interface BankingInsightsSummaryRow {
  goingWell: BankingBucketCaption;
  couldImprove: BankingBucketCaption;
  cancelThese: BankingBucketCaption;
  notInBudget: BankingBucketCaption;
  summarySource: "ai" | "fallback";
  generatedAt: string;
}

type ParsedCaptions = Omit<BankingInsightsSummaryRow, "summarySource" | "generatedAt">;

const BUCKET_KEYS = ["goingWell", "couldImprove", "cancelThese", "notInBudget"] as const;

function parseLLMResponse(raw: string): ParsedCaptions | null {
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
  const out: Partial<ParsedCaptions> = {};
  for (const key of BUCKET_KEYS) {
    const b = p[key];
    if (!b || typeof b !== "object") return null;
    const headline = String((b as Record<string, unknown>).headline ?? "").trim();
    const caption = String((b as Record<string, unknown>).caption ?? "").trim();
    if (!headline || !caption) return null;
    out[key] = { headline, caption };
  }
  return out as ParsedCaptions;
}

// ---------------------------------------------------------------------------
// Deterministic fallback (no AI)
// ---------------------------------------------------------------------------

export function buildFallbackCaptions(
  f: BankingInsightsFacts,
): BankingInsightsSummaryRow {
  const gwTop = f.goingWell.underBudget[0];
  const goingWell: BankingBucketCaption = gwTop
    ? {
        headline: "Some of this is actually working",
        caption: `${gwTop.name} is ${money(gwTop.left)} under budget${
          f.goingWell.momDeltaPct != null && f.goingWell.momDeltaPct < 0
            ? `, and spend is ${Math.abs(f.goingWell.momDeltaPct)}% below last month's pace`
            : ""
        }.`,
      }
    : {
        headline: "Nothing to brag about yet",
        caption: "No category is under budget this month — no wins to report.",
      };

  const ciTop = f.couldImprove.overBudget[0];
  const couldImprove: BankingBucketCaption = ciTop
    ? {
        headline: "The budget-busters",
        caption: `${ciTop.name} is ${money(ciTop.over)} over plan — ${money(f.couldImprove.totalOver)} of overspend across ${f.couldImprove.overBudget.length} categor${f.couldImprove.overBudget.length === 1 ? "y" : "ies"}.`,
      }
    : {
        headline: "No blowouts this month",
        caption: "Every budgeted category is at or under plan. Keep it that way.",
      };

  const ctTop = f.cancelThese.subs[0];
  const cancelThese: BankingBucketCaption = ctTop
    ? {
        headline: "Subscriptions bleeding you dry",
        caption: `${f.cancelThese.subs.length} recurring charges detected — ${money(f.cancelThese.totalAnnual)}/yr, led by ${ctTop.merchant} at ${money(ctTop.annual)}/yr.`,
      }
    : {
        headline: "No subscription leaks found",
        caption: "Nothing recurring-and-cancellable detected in your spending.",
      };

  const nbRec = f.notInBudget.untrackedRecurring[0];
  const nbCat = f.notInBudget.unbudgetedCategories[0];
  const notInBudget: BankingBucketCaption =
    nbRec || nbCat
      ? {
          headline: "Money leaving with no plan",
          caption: nbRec
            ? `${f.notInBudget.untrackedRecurring.length} recurring charge${f.notInBudget.untrackedRecurring.length === 1 ? "" : "s"} never set up as bills — ${nbRec.merchant} alone is ~${money(nbRec.monthly)}/mo.`
            : `${nbCat!.name} took ${money(nbCat!.actual)} this month with no budget line at all.`,
        }
      : {
          headline: "Everything's accounted for",
          caption: "Every recurring charge is tracked and every spend category has a budget line.",
        };

  return {
    goingWell,
    couldImprove,
    cancelThese,
    notInBudget,
    summarySource: "fallback",
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Anthropic call
// ---------------------------------------------------------------------------

async function callAnthropicWithTimeout(
  facts: BankingInsightsFacts,
): Promise<ParsedCaptions | null> {
  const client = getClient();
  if (!client) return null;
  const userPrompt = `FACTS:\n${formatFactsForPrompt(facts)}\n\nWrite the JSON now.`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ANTHROPIC_TIMEOUT_MS);
  try {
    // Fable 5: thinking is always on (omit the param — adaptive-only) and
    // sampling params are removed; the plain call shape below is correct.
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

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Generate the four bucket captions for the given deterministic facts.
 * Three-layer fallback, identical in spirit to generateAvalancheSummary:
 *   1. AI call → usable JSON → return it (summarySource "ai").
 *   2. Timeout / parse failure / no client → deterministic template.
 *   3. Any outer exception → the same deterministic template (it is pure);
 *      if even THAT throws, a minimal hardcoded caption set.
 */
export async function generateBankingInsightsSummary(
  facts: BankingInsightsFacts,
): Promise<BankingInsightsSummaryRow> {
  try {
    const llm = await callAnthropicWithTimeout(facts);
    if (llm) {
      return {
        ...llm,
        summarySource: "ai",
        generatedAt: new Date().toISOString(),
      };
    }
    logger.warn("banking-insights: LLM returned no usable captions, using fallback");
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "banking-insights: LLM call failed, using fallback",
    );
  }
  try {
    return buildFallbackCaptions(facts);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "banking-insights: fallback template failed, using minimal captions",
    );
    const minimal: BankingBucketCaption = {
      headline: "Insights ready",
      caption: "The numbers are on the cards below.",
    };
    return {
      goingWell: minimal,
      couldImprove: minimal,
      cancelThese: minimal,
      notInBudget: minimal,
      summarySource: "fallback",
      generatedAt: new Date().toISOString(),
    };
  }
}
