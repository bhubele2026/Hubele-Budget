// (#802 — Phase E) Advisor takeaway generator for the Weekly Debrief.
//
// Pipeline:
//   1. Load the just-locked week's variance snapshot.
//   2. Load the prior 4 LOCKED weeks for cross-week pattern detection.
//   3. Compute DETERMINISTIC facts (streaks, shortfalls, recurring
//      unplanned, net-accuracy trend, biggest variance). These are
//      ground truth — the LLM only narrates them, it never invents
//      its own numbers.
//   4. Feed the facts to Anthropic with a strict prompt + JSON schema.
//   5. On any error (no API key, network, timeout, parse failure),
//      fall back to a deterministic template summary built from the
//      same facts. Lock flow MUST NOT fail if AI is down.
//
// Storage: callers persist the returned summary on
// weeklyDebriefsTable.advisorSummary (a JSONB column). Re-generation
// is supported via the public endpoint.

import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, lt, inArray } from "drizzle-orm";
import {
  db,
  weeklyDebriefsTable,
  budgetCategoriesTable,
  type DebriefAdvisorSummary,
  type DebriefVarianceSnapshot,
} from "@workspace/db";
import { logger } from "./logger";
import { VOICE_SYSTEM } from "./advisorVoice";

const DEFAULT_MODEL = "claude-fable-5";
const MAX_OUTPUT_TOKENS = 600;
const ANTHROPIC_TIMEOUT_MS = 12_000;
const PRIOR_WEEKS_TO_LOAD = 4;

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

// ---------------------------------------------------------------------------
// Deterministic fact extraction
// ---------------------------------------------------------------------------

interface CategoryFact {
  categoryId: string | null;
  name: string;
  kind: "income" | "expense";
  planned: number;
  actual: number;
  variance: number; // signed: positive = overspent (expense) / overearned (income)
}

interface OverspendStreak {
  categoryId: string | null;
  name: string;
  weeks: number; // consecutive locked weeks (including current) over planned
  totalOverspend: number; // sum of overspend across the streak
}

interface IncomeShortfall {
  categoryId: string | null;
  name: string;
  planned: number;
  actual: number;
  shortfall: number; // planned - actual (positive number)
}

interface RecurringUnplanned {
  description: string;
  // Weeks (including current) where a matching unplanned charge appeared.
  occurrenceCount: number;
  // Most recent amount (signed dollars).
  lastAmount: number;
}

interface BiggestVariance {
  name: string;
  amount: number; // signed dollars
  direction: "over" | "under";
}

export interface DebriefFacts {
  weekStart: string;
  weekEnd: string;
  // Net accuracy as a percentage 0-100. Null when plannedNet is 0
  // (avoids divide-by-zero; the LLM is told to skip it then).
  netAccuracyPct: number | null;
  netAccuracyDirection: "up" | "down" | "flat" | "n/a";
  totals: {
    plannedNet: number;
    actualNet: number;
    plannedIncome: number;
    actualIncome: number;
    plannedExpenses: number;
    actualExpenses: number;
  };
  biggestVariance: BiggestVariance | null;
  overspendStreaks: OverspendStreak[];
  incomeShortfalls: IncomeShortfall[];
  recurringUnplanned: RecurringUnplanned[];
  // Number of prior locked weeks loaded for streak detection. Useful
  // for the fallback template to qualify "1st week" vs "Nth running".
  priorLockedWeeksAvailable: number;
}

function normalizeDescription(desc: string): string {
  return desc
    .toLowerCase()
    .replace(/[0-9]+/g, "") // strip transaction numbers
    .replace(/[^a-z\s]/g, " ") // strip punctuation
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pull the deterministic facts we'll narrate. Pure function over the
 * snapshots + category lookup — no DB access here so it's trivially
 * testable and idempotent.
 */
export function extractFacts(opts: {
  current: DebriefVarianceSnapshot;
  prior: DebriefVarianceSnapshot[]; // ordered most-recent first
  catName: Map<string, string>;
  catKind: Map<string, "income" | "expense">;
}): DebriefFacts {
  const { current, prior, catName, catKind } = opts;
  const nameFor = (id: string | null): string =>
    id ? catName.get(id) ?? "Uncategorized" : "Uncategorized";
  const kindFor = (id: string | null): "income" | "expense" =>
    id ? catKind.get(id) ?? "expense" : "expense";

  // -- Build per-category facts for the current week --
  const currentFacts: CategoryFact[] = current.byCategory.map((b) => {
    const kind = kindFor(b.categoryId);
    const planned = Number(b.plannedAmount);
    const actual = Number(b.actualAmount);
    // For expense: variance positive means overspent. For income:
    // we surface shortfall separately, but here we keep the raw
    // signed bucket variance for "biggest variance" ranking.
    const variance =
      kind === "income" ? actual - planned : actual - planned;
    return {
      categoryId: b.categoryId,
      name: nameFor(b.categoryId),
      kind,
      planned,
      actual,
      variance,
    };
  });

  // -- Biggest single variance this week (by absolute dollars) --
  let biggestVariance: BiggestVariance | null = null;
  for (const f of currentFacts) {
    if (Math.abs(f.variance) < 0.01) continue;
    if (!biggestVariance || Math.abs(f.variance) > Math.abs(biggestVariance.amount)) {
      biggestVariance = {
        name: f.name,
        amount: f.variance,
        direction: f.variance > 0 ? "over" : "under",
      };
    }
  }

  // -- Overspend streaks: expense categories over planned in 2+ weeks --
  // Walk current + prior, oldest first per category, and count
  // consecutive over-planned weeks ENDING at the current week.
  const overspendStreaks: OverspendStreak[] = [];
  for (const f of currentFacts) {
    if (f.kind !== "expense") continue;
    if (f.actual <= f.planned + 0.005) continue; // not over this week
    let streak = 1;
    let totalOver = f.actual - f.planned;
    for (const priorSnap of prior) {
      const match = priorSnap.byCategory.find(
        (b) => b.categoryId === f.categoryId,
      );
      if (!match) break;
      const pa = Number(match.actualAmount);
      const pp = Number(match.plannedAmount);
      if (pa <= pp + 0.005) break; // streak broken
      streak += 1;
      totalOver += pa - pp;
    }
    if (streak >= 2) {
      overspendStreaks.push({
        categoryId: f.categoryId,
        name: f.name,
        weeks: streak,
        totalOverspend: totalOver,
      });
    }
  }
  overspendStreaks.sort((a, b) => b.totalOverspend - a.totalOverspend);

  // -- Income shortfalls THIS week --
  const incomeShortfalls: IncomeShortfall[] = [];
  for (const f of currentFacts) {
    if (f.kind !== "income") continue;
    if (f.planned <= 0) continue;
    if (f.actual >= f.planned - 0.005) continue;
    incomeShortfalls.push({
      categoryId: f.categoryId,
      name: f.name,
      planned: f.planned,
      actual: f.actual,
      shortfall: f.planned - f.actual,
    });
  }
  incomeShortfalls.sort((a, b) => b.shortfall - a.shortfall);

  // -- Recurring unplanned: same normalized desc in 2+ weeks total --
  const unplannedByDesc = new Map<string, { count: number; lastAmount: number; rawDesc: string }>();
  const allWeeks = [current, ...prior];
  // Track first occurrence per week so multiple same-week occurrences
  // count once (we want "appears WEEK after WEEK", not "twice in one week").
  for (const snap of allWeeks) {
    const seenThisWeek = new Set<string>();
    for (const t of snap.unplannedTxns) {
      const key = normalizeDescription(t.description);
      if (!key || seenThisWeek.has(key)) continue;
      seenThisWeek.add(key);
      const cur = unplannedByDesc.get(key);
      if (cur) {
        cur.count += 1;
        if (snap === current) cur.lastAmount = Number(t.amount);
      } else {
        unplannedByDesc.set(key, {
          count: 1,
          lastAmount: Number(t.amount),
          rawDesc: t.description,
        });
      }
    }
  }
  const recurringUnplanned: RecurringUnplanned[] = [];
  for (const v of unplannedByDesc.values()) {
    if (v.count >= 2) {
      recurringUnplanned.push({
        description: v.rawDesc,
        occurrenceCount: v.count,
        lastAmount: v.lastAmount,
      });
    }
  }
  recurringUnplanned.sort((a, b) => b.occurrenceCount - a.occurrenceCount);

  // -- Net accuracy + trend --
  const plannedNet = Number(current.totals.plannedNet);
  const actualNet = Number(current.totals.actualNet);
  let netAccuracyPct: number | null = null;
  if (Math.abs(plannedNet) > 0.01) {
    netAccuracyPct = Math.max(
      0,
      (1 - Math.abs(actualNet - plannedNet) / Math.abs(plannedNet)) * 100,
    );
  }
  let netAccuracyDirection: "up" | "down" | "flat" | "n/a" = "n/a";
  if (netAccuracyPct !== null && prior.length > 0) {
    const priorSnap = prior[0];
    const pPlanned = Number(priorSnap.totals.plannedNet);
    const pActual = Number(priorSnap.totals.actualNet);
    if (Math.abs(pPlanned) > 0.01) {
      const priorAcc = Math.max(
        0,
        (1 - Math.abs(pActual - pPlanned) / Math.abs(pPlanned)) * 100,
      );
      const delta = netAccuracyPct - priorAcc;
      if (delta > 2) netAccuracyDirection = "up";
      else if (delta < -2) netAccuracyDirection = "down";
      else netAccuracyDirection = "flat";
    }
  }

  return {
    weekStart: current.weekStart,
    weekEnd: current.weekEnd,
    netAccuracyPct,
    netAccuracyDirection,
    totals: {
      plannedNet,
      actualNet,
      plannedIncome: Number(current.totals.plannedIncome),
      actualIncome: Number(current.totals.actualIncome),
      plannedExpenses: Number(current.totals.plannedExpenses),
      actualExpenses: Number(current.totals.actualExpenses),
    },
    biggestVariance,
    overspendStreaks,
    incomeShortfalls,
    recurringUnplanned,
    priorLockedWeeksAvailable: prior.length,
  };
}

// ---------------------------------------------------------------------------
// LLM call + fallback
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `${VOICE_SYSTEM}

TASK: Write the Weekly Debrief takeaway for the household budget app's locked week. Narrate the FACTS — never invent.

Output requirements:
- Respond with ONLY a JSON object, no markdown fence, no preamble.
- Schema: {"headline": string, "bullets": string[], "suggestions": [{"text": string, "toolHint"?: string}]}
- headline: ONE short sentence (max ~12 words). Plain language. Lead with the most important finding.
- bullets: 2-5 short observations. Each stands alone. Use real dollar amounts from the FACTS. Mention streaks ("3rd week running"), income shortfalls, recurring unplanned charges, and net-accuracy trend where relevant.
- suggestions: 0-2 actionable nudges. Each "text" is one short sentence. "toolHint" is optional and only if the user could plausibly invoke that tool from the advisor chat. Valid hints: "create_recurring_item", "update_budget_line", "add_mapping_rule". Omit toolHint if none fits.

Rules:
- Blunt, funny, in voice. Roast the spending, never the people.
- Use dollars to the nearest dollar (no cents) unless the cents matter (<$10 amounts).
- NEVER invent numbers. Only narrate facts present in the FACTS block — the sass is the wrapper; the figures are sacred.
- If facts are sparse, write fewer bullets — don't pad.
- Don't repeat the headline as a bullet.`;

function formatFactsForPrompt(facts: DebriefFacts): string {
  const lines: string[] = [];
  lines.push(`Week: ${facts.weekStart} → ${facts.weekEnd}`);
  lines.push(`Prior locked weeks available: ${facts.priorLockedWeeksAvailable}`);
  lines.push("");
  lines.push("TOTALS:");
  lines.push(
    `  Income: planned $${facts.totals.plannedIncome.toFixed(0)} / actual $${facts.totals.actualIncome.toFixed(0)}`,
  );
  lines.push(
    `  Expenses: planned $${facts.totals.plannedExpenses.toFixed(0)} / actual $${facts.totals.actualExpenses.toFixed(0)}`,
  );
  lines.push(
    `  Net: planned $${facts.totals.plannedNet.toFixed(0)} / actual $${facts.totals.actualNet.toFixed(0)}`,
  );
  if (facts.netAccuracyPct !== null) {
    lines.push(
      `  Net accuracy: ${facts.netAccuracyPct.toFixed(0)}% (${facts.netAccuracyDirection} vs prior week)`,
    );
  }
  lines.push("");
  if (facts.biggestVariance) {
    const bv = facts.biggestVariance;
    lines.push(
      `BIGGEST VARIANCE: ${bv.name} ${bv.direction === "over" ? "over" : "under"} plan by $${Math.abs(bv.amount).toFixed(0)}`,
    );
    lines.push("");
  }
  if (facts.overspendStreaks.length > 0) {
    lines.push("EXPENSE OVERSPEND STREAKS (consecutive locked weeks over plan):");
    for (const s of facts.overspendStreaks.slice(0, 5)) {
      lines.push(
        `  ${s.name}: ${s.weeks} weeks running, total over by $${s.totalOverspend.toFixed(0)}`,
      );
    }
    lines.push("");
  }
  if (facts.incomeShortfalls.length > 0) {
    lines.push("INCOME SHORTFALLS THIS WEEK:");
    for (const s of facts.incomeShortfalls) {
      lines.push(
        `  ${s.name}: planned $${s.planned.toFixed(0)}, actual $${s.actual.toFixed(0)} (short $${s.shortfall.toFixed(0)})`,
      );
    }
    lines.push("");
  }
  if (facts.recurringUnplanned.length > 0) {
    lines.push("RECURRING UNPLANNED CHARGES (appeared in 2+ weeks):");
    for (const r of facts.recurringUnplanned.slice(0, 5)) {
      lines.push(
        `  "${r.description.slice(0, 60)}" — ${r.occurrenceCount} weeks, last $${Math.abs(r.lastAmount).toFixed(0)}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

interface ParsedLLMSummary {
  headline: string;
  bullets: string[];
  suggestions: Array<{ text: string; toolHint?: string }>;
}

function parseLLMResponse(raw: string): ParsedLLMSummary | null {
  // Strip optional ```json fences if the model added them anyway.
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
    ? p.bullets.filter((b): b is string => typeof b === "string" && b.trim().length > 0)
    : [];
  const suggestions = Array.isArray(p.suggestions)
    ? p.suggestions
        .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
        .map((s) => ({
          text: typeof s.text === "string" ? s.text.trim() : "",
          toolHint: typeof s.toolHint === "string" ? s.toolHint : undefined,
        }))
        .filter((s) => s.text.length > 0)
        .slice(0, 2)
    : [];
  if (!headline || bullets.length === 0) return null;
  return {
    headline,
    bullets: bullets.slice(0, 5),
    suggestions,
  };
}

/** Build a deterministic fallback summary from the facts alone. */
export function buildFallbackSummary(facts: DebriefFacts): DebriefAdvisorSummary {
  const bullets: string[] = [];
  if (facts.biggestVariance) {
    const bv = facts.biggestVariance;
    bullets.push(
      `Biggest variance: ${bv.name} ${bv.direction === "over" ? "over" : "under"} plan by $${Math.abs(bv.amount).toFixed(0)}.`,
    );
  }
  for (const s of facts.overspendStreaks.slice(0, 2)) {
    bullets.push(
      `${s.name} over plan ${s.weeks} weeks running (${s.totalOverspend >= 0 ? "+" : ""}$${s.totalOverspend.toFixed(0)} total).`,
    );
  }
  for (const sh of facts.incomeShortfalls.slice(0, 2)) {
    bullets.push(
      `${sh.name} short by $${sh.shortfall.toFixed(0)} (planned $${sh.planned.toFixed(0)}, actual $${sh.actual.toFixed(0)}).`,
    );
  }
  for (const r of facts.recurringUnplanned.slice(0, 2)) {
    bullets.push(
      `"${r.description.slice(0, 40)}" has been unplanned for ${r.occurrenceCount} weeks.`,
    );
  }
  if (facts.netAccuracyPct !== null) {
    bullets.push(
      `Net accuracy: ${facts.netAccuracyPct.toFixed(0)}%${facts.netAccuracyDirection !== "n/a" ? ` (${facts.netAccuracyDirection} vs prior week)` : ""}.`,
    );
  }
  if (bullets.length === 0) {
    bullets.push(
      `Week net: planned $${facts.totals.plannedNet.toFixed(0)}, actual $${facts.totals.actualNet.toFixed(0)}.`,
    );
  }

  const suggestions: DebriefAdvisorSummary["suggestions"] = [];
  if (facts.recurringUnplanned.length > 0) {
    suggestions.push({
      text: `Consider adding "${facts.recurringUnplanned[0].description.slice(0, 30)}" as a recurring item.`,
      toolHint: "create_recurring_item",
    });
  }
  if (facts.overspendStreaks.length > 0) {
    suggestions.push({
      text: `Revisit the ${facts.overspendStreaks[0].name} budget — over plan ${facts.overspendStreaks[0].weeks} weeks running.`,
      toolHint: "update_budget_line",
    });
  }

  let headline: string;
  if (facts.overspendStreaks.length > 0) {
    const s = facts.overspendStreaks[0];
    headline = `${s.name} over for the ${s.weeks === 2 ? "2nd" : s.weeks === 3 ? "3rd" : `${s.weeks}th`} week running.`;
  } else if (facts.incomeShortfalls.length > 0) {
    const sh = facts.incomeShortfalls[0];
    headline = `${sh.name} fell short by $${sh.shortfall.toFixed(0)}.`;
  } else if (facts.biggestVariance) {
    const bv = facts.biggestVariance;
    headline = `${bv.name} ${bv.direction === "over" ? "over" : "under"} plan by $${Math.abs(bv.amount).toFixed(0)} this week.`;
  } else if (facts.netAccuracyPct !== null) {
    headline = `Week landed ${facts.netAccuracyPct.toFixed(0)}% on plan.`;
  } else {
    headline = "Week locked with no notable variance.";
  }

  return {
    generatedAt: new Date().toISOString(),
    headline,
    bullets: bullets.slice(0, 5),
    suggestions: suggestions.slice(0, 2),
    source: "fallback",
  };
}

async function callAnthropicWithTimeout(
  facts: DebriefFacts,
): Promise<ParsedLLMSummary | null> {
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

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Generate (and return) an advisor takeaway for the given week. Pure
 * computation + AI call — does NOT persist; the caller stores the
 * result on weeklyDebriefsTable.advisorSummary.
 *
 * Throws only if the current week has no varianceSnapshot (caller
 * error — must lock or compute first). All AI errors are swallowed
 * and replaced with a deterministic fallback summary.
 */
export async function generateDebriefSummary(opts: {
  householdId: string;
  weekStart: string;
  // Optional override — letting the lock handler pass the freshly
  // computed snapshot avoids an extra DB round-trip.
  currentSnapshot?: DebriefVarianceSnapshot;
}): Promise<DebriefAdvisorSummary> {
  const { householdId, weekStart } = opts;

  // -- Load current snapshot --
  let current = opts.currentSnapshot ?? null;
  if (!current) {
    const [row] = await db
      .select()
      .from(weeklyDebriefsTable)
      .where(
        and(
          eq(weeklyDebriefsTable.householdId, householdId),
          eq(weeklyDebriefsTable.weekStart, weekStart),
        ),
      );
    if (!row?.varianceSnapshot) {
      throw new Error(
        `No variance snapshot available for week ${weekStart}; lock the week first`,
      );
    }
    current = row.varianceSnapshot;
  }

  // -- Load up to PRIOR_WEEKS_TO_LOAD prior LOCKED weeks (most recent first) --
  const priorRows = await db
    .select({
      weekStart: weeklyDebriefsTable.weekStart,
      varianceSnapshot: weeklyDebriefsTable.varianceSnapshot,
    })
    .from(weeklyDebriefsTable)
    .where(
      and(
        eq(weeklyDebriefsTable.householdId, householdId),
        eq(weeklyDebriefsTable.status, "locked"),
        lt(weeklyDebriefsTable.weekStart, weekStart),
      ),
    )
    .orderBy(desc(weeklyDebriefsTable.weekStart))
    .limit(PRIOR_WEEKS_TO_LOAD);
  const prior: DebriefVarianceSnapshot[] = priorRows
    .map((r) => r.varianceSnapshot)
    .filter((s): s is DebriefVarianceSnapshot => !!s);

  // -- Load category names + kinds for all category ids referenced --
  const catIds = new Set<string>();
  for (const snap of [current, ...prior]) {
    for (const b of snap.byCategory) {
      if (b.categoryId) catIds.add(b.categoryId);
    }
  }
  const catName = new Map<string, string>();
  const catKind = new Map<string, "income" | "expense">();
  if (catIds.size > 0) {
    const cats = await db
      .select({
        id: budgetCategoriesTable.id,
        name: budgetCategoriesTable.name,
        kind: budgetCategoriesTable.kind,
      })
      .from(budgetCategoriesTable)
      .where(inArray(budgetCategoriesTable.id, [...catIds]));
    for (const c of cats) {
      catName.set(c.id, c.name);
      catKind.set(c.id, (c.kind as "income" | "expense") ?? "expense");
    }
  }

  const facts = extractFacts({ current, prior, catName, catKind });

  // -- Try the LLM, fall back on any failure --
  try {
    const llm = await callAnthropicWithTimeout(facts);
    if (llm) {
      return {
        generatedAt: new Date().toISOString(),
        headline: llm.headline,
        bullets: llm.bullets,
        suggestions: llm.suggestions,
        source: "ai",
      };
    }
    logger.warn({ weekStart }, "debrief-advisor: LLM returned no usable summary, using fallback");
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), weekStart },
      "debrief-advisor: LLM call failed, using fallback",
    );
  }
  return buildFallbackSummary(facts);
}
