// Forecast insights — Fable 5 cash-flow read for the Forecast area.
//
// Follows billsInsights.ts / avalancheAdvisorSummary.ts exactly: Fable 5,
// DEFAULT_MODEL, 12s AbortController, 3-layer fallback (AI → deterministic
// template → minimal). Own env override FORECAST_ADVISOR_MODEL.
//
// CLAUDE.md §1: every number here is computed deterministically by
// computeCashSignal + the runway calc below; Fable 5 only writes the language.

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";
import { VOICE_SYSTEM } from "./advisorVoice";
import { computeCashSignal, type CashSignal } from "./cashSignal";

const DEFAULT_MODEL = "claude-fable-5";
const MAX_OUTPUT_TOKENS = 600;
const ANTHROPIC_TIMEOUT_MS = 12_000;
// The horizon the cash-flow read reasons over (matches the forecast page's
// mid horizon). Runway is derived from the daily series within it.
const INSIGHT_HORIZON_DAYS = 90;

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

// ---------------------------------------------------------------------------
// Deterministic facts
// ---------------------------------------------------------------------------

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
  hashInput: unknown;
}

function daysBetweenISO(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
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

TASK: Give a short, plain read on the household's cash-flow FORECAST over the next few months. The app has computed every number deterministically (today's balance, the projected low point + date, the cash buffer, runway, income vs expenses). Narrate and advise — never compute, never invent a number.

Output requirements:
- Respond with ONLY a JSON object, no markdown fence, no preamble.
- Schema: {"headline": string, "bullets": string[]}
- headline: <= 8 words — the state of the cash flow.
- bullets: 2-4 short strings covering: the projected LOW POINT (amount + when) vs the buffer, the RUNWAY / risk ahead (when/if it dips below the buffer or goes negative), and one concrete nudge. Reference only amounts/dates in the FACTS.

Rules:
- Whole dollars only.
- Be time-aware and honest — if the forecast stays healthy, say so plainly; if it dips, name when.
- NEVER invent numbers or dates — only values in the FACTS block.`;

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
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Output + parse + fallback
// ---------------------------------------------------------------------------

export interface ForecastInsightsSummaryRow {
  headline: string;
  bullets: string[];
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

export function buildFallbackSummary(f: ForecastFacts): ForecastInsightsSummaryRow {
  const bullets: string[] = [];
  bullets.push(
    `Projected low is ${money(f.lowestProjected)}${f.lowestDate ? ` on ${f.lowestDate}` : ""}, against a ${money(f.cashBuffer)} buffer.`,
  );
  if (f.runwayDays != null)
    bullets.push(`Heads up — the balance goes negative in about ${f.runwayDays} days at this pace.`);
  else if (f.daysUntilBelowBuffer != null)
    bullets.push(`It dips below your buffer in about ${f.daysUntilBelowBuffer} days — watch that stretch.`);
  else
    bullets.push(`You stay above the buffer the whole window — solid.`);
  if (f.maxSafeExtra > 0)
    bullets.push(`There's ${money(f.maxSafeExtra)} of safe room to throw at debt right now.`);
  return {
    headline:
      f.status === "ready"
        ? "Cash flow looks healthy"
        : f.status === "tight"
          ? "Cash flow is running tight"
          : f.status === "not_yet"
            ? "Cash flow dips below the buffer"
            : "Not enough data yet",
    bullets,
    summarySource: "fallback",
    generatedAt: new Date().toISOString(),
  };
}

async function callAnthropicWithTimeout(
  facts: ForecastFacts,
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

export async function generateForecastInsightsSummary(
  facts: ForecastFacts,
): Promise<ForecastInsightsSummaryRow> {
  try {
    const llm = await callAnthropicWithTimeout(facts);
    if (llm)
      return {
        headline: llm.headline,
        bullets: llm.bullets,
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
      bullets: ["Your projected balance is on the chart below."],
      summarySource: "fallback",
      generatedAt: new Date().toISOString(),
    };
  }
}
