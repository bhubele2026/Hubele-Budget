// Spending story — Fable 5 read of household spending in four lenses.
//
// Follows forecastInsights.ts / billsInsights.ts exactly: Fable 5, DEFAULT_MODEL,
// 12s AbortController, 3-layer fallback (AI → deterministic template → minimal).
// Own env override SPENDING_STORY_MODEL.
//
// CLAUDE.md §1: every number is computed deterministically by buildSpendingFacts
// (+ the derivations below); Fable 5 only writes the language for each lens — it
// never computes or invents a figure.
//
// Backs the click-to-expand analysis on the Overview spending graphics: four
// lenses (trend, category mix, top merchants, day-of-week), household-wide
// (Amex + Chase combined).

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";
import { VOICE_SYSTEM } from "./advisorVoice";
import { buildSpendingFacts, type SpendingFacts } from "./spendingFacts";

const DEFAULT_MODEL = "claude-fable-5";
const MAX_OUTPUT_TOKENS = 700;
const ANTHROPIC_TIMEOUT_MS = 12_000;

const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (process.env.ADVISOR_ENABLED === "false") return null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!_client) _client = new Anthropic({ apiKey });
  return _client;
}
function getModel(): string {
  return process.env.SPENDING_STORY_MODEL || DEFAULT_MODEL;
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

// ---------------------------------------------------------------------------
// Deterministic derived facts (per lens)
// ---------------------------------------------------------------------------

export interface SpendingStoryFacts {
  windowLabel: string;
  daysCovered: number;
  total: number;
  txnCount: number;
  avgPerDay: number;
  // trend
  busiestDay: { date: string; total: number } | null;
  firstHalfTotal: number;
  secondHalfTotal: number;
  trendDirection: "rising" | "falling" | "flat";
  // category
  topCategories: { name: string; total: number; pct: number }[];
  uncategorizedTotal: number;
  // merchants
  topMerchants: { name: string; total: number; count: number }[];
  // day of week
  topWeekdays: { label: string; avgPerDay: number; total: number }[];
  // hash material
  hashInput: unknown;
}

export function buildSpendingStoryFacts(facts: SpendingFacts): SpendingStoryFacts {
  const total = facts.realSpend.total;
  const days = Math.max(1, facts.range.daysCovered);

  const daily = [...facts.dailyBuckets].sort((a, b) => a.date.localeCompare(b.date));
  const busiestDay =
    daily.length > 0
      ? daily.reduce((best, d) => (d.total > best.total ? d : best), daily[0])
      : null;
  const mid = Math.floor(daily.length / 2);
  const firstHalfTotal = daily.slice(0, mid).reduce((s, d) => s + d.total, 0);
  const secondHalfTotal = daily.slice(mid).reduce((s, d) => s + d.total, 0);
  const diff = secondHalfTotal - firstHalfTotal;
  const threshold = Math.max(25, total * 0.1);
  const trendDirection: SpendingStoryFacts["trendDirection"] =
    diff > threshold ? "rising" : diff < -threshold ? "falling" : "flat";

  const topCategories = [...facts.byCategory]
    .filter((c) => !/uncategorized/i.test(c.name))
    .slice(0, 5)
    .map((c) => ({ name: c.name, total: c.total, pct: Math.round(c.pctOfRealSpend) }));

  const topMerchants = facts.byMerchant
    .slice(0, 6)
    .map((m) => ({ name: m.name, total: m.total, count: m.count }));

  const topWeekdays = [...facts.dayOfWeek]
    .sort((a, b) => b.total - a.total)
    .slice(0, 3)
    .map((d) => ({
      label: DOW_NAMES[d.dow] ?? d.label,
      avgPerDay: d.avgPerDay,
      total: d.total,
    }));

  const windowLabel = `${facts.range.start} → ${facts.range.end}`;

  const derived: Omit<SpendingStoryFacts, "hashInput"> = {
    windowLabel,
    daysCovered: days,
    total,
    txnCount: facts.realSpend.transactionCount,
    avgPerDay: days > 0 ? total / days : 0,
    busiestDay: busiestDay ? { date: busiestDay.date, total: busiestDay.total } : null,
    firstHalfTotal,
    secondHalfTotal,
    trendDirection,
    topCategories,
    uncategorizedTotal: facts.uncategorized.total,
    topMerchants,
    topWeekdays,
  };
  return { ...derived, hashInput: derived };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `${VOICE_SYSTEM}

TASK: Give a short, plain-language read of the household's SPENDING (Amex + Chase combined) over the given window, told through FOUR lenses. The app has computed every number deterministically — the total, the trend shape, the top categories, the top merchants, and the day-of-week pattern. Narrate what each lens says and what it means; never compute, never invent a number.

Output requirements:
- Respond with ONLY a JSON object, no markdown fence, no preamble.
- Schema: {"trend": Lens, "category": Lens, "merchants": Lens, "dayOfWeek": Lens} where Lens = {"headline": string, "bullets": string[]}.
- Each headline: <= 8 words, the one-line takeaway for that lens.
- Each bullets: 2-3 short strings, each referencing only amounts/names/dates from the FACTS.
- trend = how spending is moving over the window (rising/falling/flat, busiest day). category = where the money goes (top categories + share). merchants = who's getting paid the most. dayOfWeek = which days drive spend.

Rules:
- Whole dollars only.
- Reference ONLY values in the FACTS block — never invent a merchant, category, amount, or date.
- Be honest and encouraging; every read should help them see where to cut to get out of debt faster.`;

function formatFactsForPrompt(f: SpendingStoryFacts): string {
  const lines: string[] = [];
  lines.push(`WINDOW: ${f.windowLabel} (${f.daysCovered} days)`);
  lines.push(`Total real spend: ${money(f.total)} across ${f.txnCount} purchases · avg ${money(f.avgPerDay)}/day`);
  lines.push("");
  lines.push(
    `TREND: first half ${money(f.firstHalfTotal)} vs second half ${money(f.secondHalfTotal)} → ${f.trendDirection}` +
      (f.busiestDay ? ` · busiest day ${f.busiestDay.date} at ${money(f.busiestDay.total)}` : ""),
  );
  lines.push("");
  lines.push("TOP CATEGORIES (where it goes):");
  if (f.topCategories.length === 0) lines.push("  (none categorized yet)");
  for (const c of f.topCategories) lines.push(`  ${c.name}: ${money(c.total)} (${c.pct}% of spend)`);
  if (f.uncategorizedTotal > 0) lines.push(`  Uncategorized: ${money(f.uncategorizedTotal)}`);
  lines.push("");
  lines.push("TOP MERCHANTS (who's getting paid):");
  if (f.topMerchants.length === 0) lines.push("  (none yet)");
  for (const m of f.topMerchants) lines.push(`  ${m.name}: ${money(m.total)} over ${m.count} charge${m.count === 1 ? "" : "s"}`);
  lines.push("");
  lines.push("BY DAY OF WEEK (top spending days):");
  if (f.topWeekdays.length === 0) lines.push("  (no data)");
  for (const d of f.topWeekdays) lines.push(`  ${d.label}: ${money(d.total)} total (avg ${money(d.avgPerDay)}/day)`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Output + parse + fallback
// ---------------------------------------------------------------------------

export interface StoryLens {
  headline: string;
  bullets: string[];
}
export interface SpendingStoryRow {
  lenses: {
    trend: StoryLens;
    category: StoryLens;
    merchants: StoryLens;
    dayOfWeek: StoryLens;
  };
  summarySource: "ai" | "fallback";
  generatedAt: string;
}

type LensKey = keyof SpendingStoryRow["lenses"];
const LENS_KEYS: LensKey[] = ["trend", "category", "merchants", "dayOfWeek"];

function parseLens(v: unknown): StoryLens | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const headline = typeof o.headline === "string" ? o.headline.trim() : "";
  const bullets = Array.isArray(o.bullets)
    ? o.bullets.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : [];
  if (!headline) return null;
  return { headline, bullets };
}

function parseLLMResponse(raw: string): SpendingStoryRow["lenses"] | null {
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
  const out = {} as SpendingStoryRow["lenses"];
  for (const k of LENS_KEYS) {
    const lens = parseLens(p[k]);
    if (!lens) return null;
    out[k] = lens;
  }
  return out;
}

export function buildFallbackStory(f: SpendingStoryFacts): SpendingStoryRow {
  const trendWord =
    f.trendDirection === "rising"
      ? "climbing"
      : f.trendDirection === "falling"
        ? "easing off"
        : "holding steady";
  const cat = f.topCategories[0];
  const merch = f.topMerchants[0];
  const day = f.topWeekdays[0];
  return {
    lenses: {
      trend: {
        headline: `Spending is ${trendWord}`,
        bullets: [
          `${money(f.total)} over ${f.daysCovered} days — about ${money(f.avgPerDay)} a day.`,
          f.busiestDay
            ? `Biggest day was ${f.busiestDay.date} at ${money(f.busiestDay.total)}.`
            : `No standout spending day yet.`,
        ],
      },
      category: {
        headline: cat ? `${cat.name} leads your spending` : "Not much categorized yet",
        bullets: cat
          ? f.topCategories
              .slice(0, 3)
              .map((c) => `${c.name}: ${money(c.total)} (${c.pct}% of spend).`)
          : ["Categorize a few charges to see where the money goes."],
      },
      merchants: {
        headline: merch ? `${merch.name} is your top merchant` : "No merchants yet",
        bullets: merch
          ? f.topMerchants
              .slice(0, 3)
              .map((m) => `${m.name}: ${money(m.total)} over ${m.count} charge${m.count === 1 ? "" : "s"}.`)
          : ["No recurring merchants in this window."],
      },
      dayOfWeek: {
        headline: day ? `${day.label} is your heaviest day` : "No day-of-week pattern yet",
        bullets: day
          ? f.topWeekdays.map((d) => `${d.label}: ${money(d.total)} total (avg ${money(d.avgPerDay)}/day).`)
          : ["Not enough spending to spot a weekly rhythm."],
      },
    },
    summarySource: "fallback",
    generatedAt: new Date().toISOString(),
  };
}

async function callAnthropicWithTimeout(
  f: SpendingStoryFacts,
): Promise<SpendingStoryRow["lenses"] | null> {
  const client = getClient();
  if (!client) return null;
  const userPrompt = `FACTS:\n${formatFactsForPrompt(f)}\n\nWrite the JSON now.`;
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

export async function generateSpendingStory(
  f: SpendingStoryFacts,
): Promise<SpendingStoryRow> {
  try {
    const lenses = await callAnthropicWithTimeout(f);
    if (lenses)
      return { lenses, summarySource: "ai", generatedAt: new Date().toISOString() };
    logger.warn("spending-story: LLM returned no usable summary, using fallback");
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "spending-story: LLM call failed, using fallback",
    );
  }
  try {
    return buildFallbackStory(f);
  } catch {
    const empty: StoryLens = { headline: "Spending", bullets: ["See the graphic above."] };
    return {
      lenses: { trend: empty, category: empty, merchants: empty, dayOfWeek: empty },
      summarySource: "fallback",
      generatedAt: new Date().toISOString(),
    };
  }
}
