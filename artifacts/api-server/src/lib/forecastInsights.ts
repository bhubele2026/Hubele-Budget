// Forecast insights — Fable 5 cash-flow read for the Forecast area.
//
// Follows billsInsights.ts / avalancheAdvisorSummary.ts exactly: Fable 5,
// DEFAULT_MODEL, 12s AbortController, 3-layer fallback (AI → deterministic
// template → minimal). Own env override FORECAST_ADVISOR_MODEL.
//
// CLAUDE.md §1: every number here is computed deterministically by
// computeCashSignal + buildHouseholdFacts + the derivations below; Fable 5 only
// writes the language — it never computes or invents a figure.
//
// The read covers the WHOLE 90-day horizon (month-by-month shape + the biggest
// upcoming bills) and gives concrete debt moves, not just a near-term one-liner.

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";
import { VOICE_SYSTEM } from "./advisorVoice";
import { computeCashSignal, type CashSignal } from "./cashSignal";
import {
  buildHouseholdFacts,
  formatDebtSliceForPrompt,
  debtDirective,
  type HouseholdFacts,
} from "./householdFacts";

const DEFAULT_MODEL = "claude-fable-5";
const MAX_OUTPUT_TOKENS = 900;
const ANTHROPIC_TIMEOUT_MS = 12_000;
// The horizon the cash-flow read reasons over (matches the forecast page's
// mid horizon). Runway + the month-by-month shape are derived within it.
const INSIGHT_HORIZON_DAYS = 90;

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (process.env.ADVISOR_ENABLED === "false") return null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!_client) _client = new Anthropic({ apiKey });
  return _client;
}
function getModel(): string {
  return process.env.FORECAST_ADVISOR_MODEL || DEFAULT_MODEL;
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}
function num(v: string | number | null | undefined): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}
function monthLabelFromISO(iso: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${MONTH_NAMES[Number(m[2]) - 1]} ${m[1]}`;
}

// ---------------------------------------------------------------------------
// Deterministic facts
// ---------------------------------------------------------------------------

export interface ForecastMonthPoint {
  label: string; // "Jul 2026"
  endBalance: number; // projected balance on the last in-window day of the month
  low: number; // lowest projected balance during the month
}
export interface ForecastBill {
  date: string;
  label: string;
  amount: number; // positive magnitude of the outflow
}

export interface ForecastFacts {
  horizonDays: number;
  bankToday: number;
  lowestProjected: number;
  lowestDate: string | null;
  cashBuffer: number;
  status: CashSignal["status"];
  maxSafeExtra: number;
  startingBalance: number;
  endingBalance: number;
  projectedIncome: number;
  projectedExpenses: number;
  /** Days until the projected balance first goes negative (null if it never does). */
  runwayDays: number | null;
  /** Days until the projected balance first dips below the cash buffer (null if never). */
  daysUntilBelowBuffer: number | null;
  /** How many days in the window dip below the buffer. */
  dipDays: number;
  /** Month-by-month shape of the 90-day projection (end balance + low per month). */
  months: ForecastMonthPoint[];
  /** The biggest upcoming bills/outflows in the window. */
  bigBills: ForecastBill[];
  /** The household debt-payoff slice (North Star) — targetDebt, months to freedom, etc. */
  debt: HouseholdFacts;
  hashInput: unknown;
}

function daysBetweenISO(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** Collapse the per-day series into per-month end-balance + low points. */
function monthsFromDaily(
  daily: Array<{ date: string; balance: string }>,
): ForecastMonthPoint[] {
  const byMonth = new Map<string, { end: number; endDate: string; low: number }>();
  for (const pt of daily) {
    const key = pt.date.slice(0, 7);
    const bal = num(pt.balance);
    const cur = byMonth.get(key);
    if (!cur) {
      byMonth.set(key, { end: bal, endDate: pt.date, low: bal });
    } else {
      if (pt.date >= cur.endDate) {
        cur.end = bal;
        cur.endDate = pt.date;
      }
      if (bal < cur.low) cur.low = bal;
    }
  }
  return [...byMonth.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, v]) => ({
      label: monthLabelFromISO(`${key}-01`),
      endBalance: Math.round(v.end * 100) / 100,
      low: Math.round(v.low * 100) / 100,
    }));
}

/** Top outflows by magnitude in the window. */
function bigBillsFromEvents(
  events: Array<{ date: string; label: string; amount: string }>,
): ForecastBill[] {
  return events
    .map((e) => ({ date: e.date, label: e.label, amount: num(e.amount) }))
    .filter((e) => e.amount < 0)
    .sort((a, b) => a.amount - b.amount) // most negative first
    .slice(0, 6)
    .map((e) => ({ date: e.date, label: e.label, amount: Math.abs(e.amount) }));
}

export async function buildForecastFacts(
  householdId: string,
  ownerId: string,
): Promise<ForecastFacts> {
  const signal = await computeCashSignal(householdId, ownerId, {
    horizonDays: INSIGHT_HORIZON_DAYS,
  });
  const daily = signal.daily ?? [];
  const cashBuffer = num(signal.cashBuffer);
  const firstDate = daily[0]?.date ?? null;

  // Runway = days from the window start until the balance first goes negative;
  // days-until-below-buffer = same but the buffer line. dipDays = count below buffer.
  let runwayDays: number | null = null;
  let daysUntilBelowBuffer: number | null = null;
  let dipDays = 0;
  for (const pt of daily) {
    const bal = num(pt.balance);
    if (bal < 0 && runwayDays === null && firstDate)
      runwayDays = Math.max(0, daysBetweenISO(firstDate, pt.date));
    if (bal < cashBuffer) {
      dipDays++;
      if (daysUntilBelowBuffer === null && firstDate)
        daysUntilBelowBuffer = Math.max(0, daysBetweenISO(firstDate, pt.date));
    }
  }

  const months = monthsFromDaily(daily);
  const bigBills = bigBillsFromEvents(signal.events ?? []);
  // The debt slice is best-effort (never throws — ZERO_FACTS fallback), so a
  // debt-facts hiccup can never break the forecast read.
  const debt = await buildHouseholdFacts(householdId, ownerId);

  const facts: ForecastFacts = {
    horizonDays: signal.horizonDays ?? INSIGHT_HORIZON_DAYS,
    bankToday: num(signal.bankToday),
    lowestProjected: num(signal.lowestProjected),
    lowestDate: signal.lowestDate ?? null,
    cashBuffer,
    status: signal.status,
    maxSafeExtra: num(signal.maxSafeExtra),
    startingBalance: num(signal.startingBalance),
    endingBalance: num(signal.endingBalance),
    projectedIncome: num(signal.projectedIncome),
    projectedExpenses: num(signal.projectedExpenses),
    runwayDays,
    daysUntilBelowBuffer,
    dipDays,
    months,
    bigBills,
    debt,
    hashInput: null,
  };
  facts.hashInput = {
    b: facts.bankToday,
    lp: facts.lowestProjected,
    ld: facts.lowestDate,
    st: facts.status,
    e: facts.endingBalance,
    r: facts.runwayDays,
    dub: facts.daysUntilBelowBuffer,
    m: months.map((m) => [m.label, m.endBalance, m.low]),
    bb: bigBills.map((b) => [b.date, b.amount]),
    dt: [debt.targetDebt?.name ?? null, debt.monthsToFreedom, debt.maxSafeExtra],
  };
  return facts;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const STATUS_WORD: Record<CashSignal["status"], string> = {
  ready: "healthy — clear room above the buffer",
  tight: "tight — hovering near the cash buffer",
  not_yet: "at risk — the projection dips below the buffer",
  no_data: "not enough data yet",
};

const SYSTEM_PROMPT = `${VOICE_SYSTEM}

TASK: Give a full read on the household's cash-flow FORECAST over the WHOLE next ~90 days, plus concrete debt moves. The app has computed every number deterministically (today's balance, the month-by-month projected shape, the low point + date, the cash buffer, runway, income vs expenses, the biggest upcoming bills, and the debt-payoff picture). Narrate and advise — never compute, never invent a number or date.

Output requirements:
- Respond with ONLY a JSON object, no markdown fence, no preamble.
- Schema: {"headline": string, "body": string, "bullets": string[], "debtMoves": string[]}
- headline: <= 10 words — the overall state of the 90-day cash flow.
- body: 3-5 sentences giving a real OVERVIEW of the full 90 days: the trajectory (where the balance heads month by month, naming the months and their end balances from the FACTS), the low point (amount + when) vs the buffer, and the one or two biggest bills to brace for. This is the fuller picture the household wants — cover the whole window, not just the next few days.
- bullets: 2-4 short at-a-glance strings (low point vs buffer; runway / when it dips; the biggest single bill). Reference only amounts/dates in the FACTS.
- debtMoves: 1-3 concrete, safe debt actions from the DEBT-PAYOFF PICTURE facts — e.g. send the safe extra to the named highest-APR debt, and what it buys (months/interest saved, freedom date). If there's no active debt or no safe room, say so honestly in ONE item instead of inventing a move.

Rules:
- Whole dollars only.
- Be time-aware and honest — if the forecast stays healthy, say so plainly; if it dips, name when. Encourage, never shame.
- NEVER invent numbers or dates — only values in the FACTS block. Never state a debt-free date, months-to-freedom, or savings figure that isn't in the FACTS.`;

function formatFactsForPrompt(f: ForecastFacts): string {
  const lines: string[] = [];
  lines.push(`HORIZON: next ${f.horizonDays} days`);
  lines.push(`Bank today: ${money(f.bankToday)} · Cash buffer: ${money(f.cashBuffer)}`);
  lines.push(`Status: ${STATUS_WORD[f.status]}`);
  lines.push(
    `Projected LOW point: ${money(f.lowestProjected)}${f.lowestDate ? ` on ${f.lowestDate}` : ""} (buffer is ${money(f.cashBuffer)})`,
  );
  lines.push(
    `Ending balance at horizon: ${money(f.endingBalance)} (income ${money(f.projectedIncome)} vs expenses ${money(f.projectedExpenses)})`,
  );
  if (f.runwayDays != null)
    lines.push(`Runway: balance first goes NEGATIVE in ${f.runwayDays} days`);
  else lines.push(`Runway: balance never goes negative in this window`);
  if (f.daysUntilBelowBuffer != null)
    lines.push(`First dip below buffer: in ${f.daysUntilBelowBuffer} days (${f.dipDays} days below buffer total)`);
  else lines.push(`Never dips below the cash buffer in this window`);
  lines.push(`Max safe extra toward debt right now: ${money(f.maxSafeExtra)}`);

  if (f.months.length) {
    lines.push("");
    lines.push("MONTH-BY-MONTH SHAPE (projected end balance + low each month):");
    for (const m of f.months) {
      lines.push(`  ${m.label}: ends ${money(m.endBalance)} (low ${money(m.low)})`);
    }
  }
  if (f.bigBills.length) {
    lines.push("");
    lines.push("BIGGEST UPCOMING BILLS (in the window):");
    for (const b of f.bigBills) {
      lines.push(`  ${b.date}: ${b.label} — ${money(b.amount)}`);
    }
  }
  const debtBlock = formatDebtSliceForPrompt(f.debt);
  if (debtBlock) {
    lines.push("");
    lines.push(debtBlock);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Output + parse + fallback
// ---------------------------------------------------------------------------

export interface ForecastInsightsSummaryRow {
  headline: string;
  body: string;
  bullets: string[];
  debtMoves: string[];
  summarySource: "ai" | "fallback";
  generatedAt: string;
}

interface ParsedLLM {
  headline: string;
  body: string;
  bullets: string[];
  debtMoves: string[];
}

function parseLLMResponse(raw: string): ParsedLLM | null {
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
  const body = typeof p.body === "string" ? p.body.trim() : "";
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim().length > 0) : [];
  const bullets = strArr(p.bullets);
  const debtMoves = strArr(p.debtMoves);
  if (!headline || !body) return null;
  return { headline, body, bullets, debtMoves };
}

export function buildFallbackSummary(f: ForecastFacts): ForecastInsightsSummaryRow {
  const bullets: string[] = [];
  bullets.push(
    `Projected low is ${money(f.lowestProjected)}${f.lowestDate ? ` on ${f.lowestDate}` : ""}, against a ${money(f.cashBuffer)} buffer.`,
  );
  if (f.runwayDays != null)
    bullets.push(`Heads up — the balance goes negative in about ${f.runwayDays} days at this pace.`);
  else if (f.daysUntilBelowBuffer != null)
    bullets.push(`It dips below your buffer in about ${f.daysUntilBelowBuffer} days — watch that stretch.`);
  else bullets.push(`You stay above the buffer the whole window — solid.`);
  if (f.bigBills[0])
    bullets.push(`Biggest bill ahead: ${f.bigBills[0].label} at ${money(f.bigBills[0].amount)} on ${f.bigBills[0].date}.`);

  // Deterministic 90-day overview paragraph from the month shape.
  const shape =
    f.months.length > 1
      ? "Month to month it runs " +
        f.months.map((m) => `${m.label} ending ${money(m.endBalance)}`).join(", ") +
        ". "
      : "";
  const body =
    `Over the next ${f.horizonDays} days your cash flow is ${STATUS_WORD[f.status]}. ` +
    shape +
    `The low point is ${money(f.lowestProjected)}${f.lowestDate ? ` on ${f.lowestDate}` : ""} against your ${money(f.cashBuffer)} buffer, and you land near ${money(f.endingBalance)} by the end of the window.`;

  // Deterministic debt moves from the North Star slice.
  const debtMoves: string[] = [];
  const directive = debtDirective(f.debt);
  if (directive) debtMoves.push(directive);
  else if (!f.debt.targetDebt) debtMoves.push("No active debt — nothing to attack. Keep building the cushion.");
  else if (f.maxSafeExtra <= 0)
    debtMoves.push("No safe extra right now — the buffer's tight. Free up room first, then throw it at the highest-APR debt.");

  return {
    headline:
      f.status === "ready"
        ? "Cash flow looks healthy over 90 days"
        : f.status === "tight"
          ? "Cash flow runs tight over 90 days"
          : f.status === "not_yet"
            ? "Cash flow dips below the buffer"
            : "Not enough data yet",
    body,
    bullets,
    debtMoves,
    summarySource: "fallback",
    generatedAt: new Date().toISOString(),
  };
}

async function callAnthropicWithTimeout(facts: ForecastFacts): Promise<ParsedLLM | null> {
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

export async function generateForecastInsightsSummary(
  facts: ForecastFacts,
): Promise<ForecastInsightsSummaryRow> {
  try {
    const llm = await callAnthropicWithTimeout(facts);
    if (llm)
      return {
        headline: llm.headline,
        body: llm.body,
        bullets: llm.bullets,
        debtMoves: llm.debtMoves,
        summarySource: "ai",
        generatedAt: new Date().toISOString(),
      };
    logger.warn("forecast-insights: LLM returned no usable summary, using fallback");
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "forecast-insights: LLM call failed, using fallback",
    );
  }
  try {
    return buildFallbackSummary(facts);
  } catch {
    return {
      headline: "Forecast ready",
      body: "Your projected balance is on the chart below.",
      bullets: ["Your projected balance is on the chart below."],
      debtMoves: [],
      summarySource: "fallback",
      generatedAt: new Date().toISOString(),
    };
  }
}
