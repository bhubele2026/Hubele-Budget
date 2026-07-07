// Fable 5 narrative for the Budget Health card.
//
// Follows avalancheAdvisorSummary.ts exactly: same Anthropic client setup, same
// DEFAULT_MODEL (claude-fable-5, ADVISOR_MODEL override), same 12s timeout via
// AbortController, same 3-layer fallback (AI → deterministic template → minimal).
//
// The score, sub-scores, deltas, and drivers all come from healthScore.ts /
// healthSnapshot.ts — DETERMINISTIC. Fable 5 only writes the words (CLAUDE.md
// §1: the AI never does arithmetic). It must never state a number not in FACTS.

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";
import { VOICE_SYSTEM } from "./advisorVoice";
import type { HealthFacts } from "./healthScore";
import type { HealthDeltas } from "./healthSnapshot";

const DEFAULT_MODEL = "claude-fable-5";
const MAX_OUTPUT_TOKENS = 500;
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

export interface HealthAdvisorSummary {
  generatedAt: string;
  headline: string; // one short line — the standing + which way it's moving
  body: string; // 2-4 sentences: how they're doing + why it moved
  nextAction: string; // the single highest-impact, debt-focused next step
  source: "ai" | "fallback";
}

function money(n: number): string {
  return `$${Math.round(Number(n) || 0).toLocaleString("en-US")}`;
}

const SYSTEM_PROMPT = `${VOICE_SYSTEM}

TASK: Narrate the household budget app's "Budget Health" card. The app has ALREADY computed a deterministic overall health score (0-100), a status band (green/yellow/red), a letter grade, four weighted sub-scores (debt trajectory is weighted heaviest — getting out of debt is the household's North Star), how the score has moved (vs yesterday and vs about a week ago), and the top helping/hurting drivers. Narrate these facts — never compute or invent them.

Output requirements:
- Respond with ONLY a JSON object, no markdown fence, no preamble.
- Schema: {"headline": string, "body": string, "nextAction": string}
- headline: ONE short line (<= 12 words) — the current standing and which way it's trending (e.g. "Holding at 58 — up 3 this week").
- body: 2-4 plain sentences. Say how they're doing overall, then WHY the score is where it is and why it moved, naming the biggest helping and hurting drivers from the FACTS. Use only figures present in FACTS. Be honest but encouraging; never shaming.
- nextAction: ONE concrete next step, biased toward debt payoff (the North Star). Prefer a specific, safe action the FACTS support (e.g. send the safe extra to the highest-APR debt, or rein in the flex category that's pacing over). Keep it to one sentence.

Rules:
- Whole dollars only (no cents). NEVER invent numbers — only values present in the FACTS block; never alter them.
- Do not restate all four sub-scores mechanically; synthesize.`;

function formatFactsForPrompt(facts: HealthFacts, deltas: HealthDeltas): string {
  const f = facts.facts;
  const lines: string[] = [];
  lines.push(`OVERALL SCORE: ${facts.score}/100 — status ${facts.status.toUpperCase()}, grade ${facts.grade}`);
  lines.push(
    `MOVEMENT: vs yesterday ${deltas.vsYesterday == null ? "n/a (first day tracked)" : signed(deltas.vsYesterday)}; ` +
      `vs ~1 week ago ${deltas.vsLastWeek == null ? "n/a" : signed(deltas.vsLastWeek)}; trend "${deltas.direction}"`,
  );
  lines.push("");
  lines.push("SUB-SCORES (0-100, with weight):");
  for (const d of facts.dimensions) {
    lines.push(`  ${d.label} [${Math.round(d.weight * 100)}%]: ${d.score} — ${d.summary}`);
  }
  lines.push("");
  lines.push("KEY FACTS (deterministic — narrate, never recompute):");
  lines.push(`  Total debt: ${money(f.totalDebt)}`);
  if (f.targetDebtName) {
    lines.push(
      `  Highest-APR target debt: ${f.targetDebtName} at ${Math.round((f.targetDebtApr ?? 0) * 100)}% APR`,
    );
  }
  lines.push(
    `  Months to debt-free: ${f.monthsToFreedom == null ? "does not converge yet (a debt may be underwater)" : f.monthsToFreedom}`,
  );
  lines.push(`  Any debt underwater: ${f.underwater ? "YES" : "no"}`);
  if (f.debtTrend30d != null) {
    lines.push(
      `  Total debt over ~30 days: ${f.debtTrend30d < 0 ? `fell ${money(Math.abs(f.debtTrend30d))}` : f.debtTrend30d > 0 ? `rose ${money(f.debtTrend30d)}` : "roughly flat"}`,
    );
  }
  lines.push(`  Safe extra available for debt now: ${money(f.maxSafeExtra)}`);
  lines.push(
    `  Cash runway: ${f.cashStatus}; lowest projected balance ${money(f.lowestProjected)} vs ${money(f.cashBuffer)} buffer`,
  );
  lines.push(
    `  Flex spending pace: ${f.flexPaceStatus}${f.flexProjectedVsPlan > 0 ? `, projected ${money(f.flexProjectedVsPlan)} over plan` : ""}`,
  );
  lines.push(`  Net cashflow this month: ${money(f.netCashflow)}; sent to debt this month: ${money(f.paidThisMonth)}`);
  if (facts.drivers.length) {
    lines.push("");
    lines.push("DRIVERS:");
    for (const d of facts.drivers) lines.push(`  ${d}`);
  }
  return lines.join("\n");
}

function signed(n: number): string {
  const r = Math.round(n);
  return r > 0 ? `+${r}` : `${r}`;
}

interface ParsedLLMSummary {
  headline: string;
  body: string;
  nextAction: string;
}

function parseLLMResponse(raw: string): ParsedLLMSummary | null {
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
  const nextAction = typeof p.nextAction === "string" ? p.nextAction.trim() : "";
  if (!headline || !body) return null;
  return { headline, body, nextAction };
}

// --- Deterministic fallback (no AI) -----------------------------------------

export function buildFallbackSummary(
  facts: HealthFacts,
  deltas: HealthDeltas,
): HealthAdvisorSummary {
  const f = facts.facts;
  const move =
    deltas.vsLastWeek == null
      ? "This is your first tracked day."
      : deltas.direction === "improving"
        ? `Up ${signed(deltas.vsLastWeek)} over the past week.`
        : deltas.direction === "slipping"
          ? `Down ${Math.abs(Math.round(deltas.vsLastWeek))} over the past week.`
          : "About the same as last week.";
  const worst = [...facts.dimensions].sort((a, b) => a.score - b.score)[0];
  const headline = `${facts.score}/100 (${facts.grade}) — ${
    deltas.direction === "new" ? "just started tracking" : deltas.direction
  }`;
  const body =
    `Your budget health is ${facts.status} at ${facts.score} out of 100. ${move} ` +
    (worst ? `The biggest drag right now is ${worst.label.toLowerCase()}: ${worst.summary}` : "");
  let nextAction: string;
  if (f.underwater) {
    nextAction = `A debt is underwater — its interest outruns its minimum. Prioritize extra payments on ${f.targetDebtName ?? "the highest-APR debt"} to stop it growing.`;
  } else if (f.maxSafeExtra > 0 && f.targetDebtName) {
    nextAction = `Send your ${money(f.maxSafeExtra)} of safe extra to ${f.targetDebtName} (highest APR) to shorten your payoff.`;
  } else if (f.flexPaceStatus === "over") {
    nextAction = `Flex spending is pacing over plan${f.flexProjectedVsPlan > 0 ? ` by about ${money(f.flexProjectedVsPlan)}` : ""} — trim it to free up cash for debt.`;
  } else {
    nextAction = "Keep sending every safe dollar to the highest-APR debt.";
  }
  return {
    generatedAt: new Date().toISOString(),
    headline,
    body: body.trim(),
    nextAction,
    source: "fallback",
  };
}

async function callAnthropicWithTimeout(
  facts: HealthFacts,
  deltas: HealthDeltas,
): Promise<ParsedLLMSummary | null> {
  const client = getClient();
  if (!client) return null;
  const userPrompt = `FACTS:\n${formatFactsForPrompt(facts, deltas)}\n\nWrite the JSON now.`;
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

/**
 * Generate the Budget Health narrative. Three-layer fallback:
 *   1. AI JSON → return it (source "ai").
 *   2. Timeout / parse failure / no client → deterministic template (fallback).
 *   3. Outer exception → minimal summary from facts (fallback).
 */
export async function generateHealthSummary(
  facts: HealthFacts,
  deltas: HealthDeltas,
): Promise<HealthAdvisorSummary> {
  try {
    const llm = await callAnthropicWithTimeout(facts, deltas);
    if (llm) {
      return {
        generatedAt: new Date().toISOString(),
        headline: llm.headline,
        body: llm.body,
        nextAction: llm.nextAction,
        source: "ai",
      };
    }
    logger.warn("health-advisor: LLM returned no usable summary, using fallback");
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "health-advisor: LLM call failed, using fallback",
    );
  }
  try {
    return buildFallbackSummary(facts, deltas);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "health-advisor: fallback failed, using minimal summary",
    );
    return {
      generatedAt: new Date().toISOString(),
      headline: `Budget health: ${facts.score}/100`,
      body: `Your budget health is ${facts.status} at ${facts.score} out of 100.`,
      nextAction: "Keep sending every safe dollar to the highest-APR debt.",
      source: "fallback",
    };
  }
}
