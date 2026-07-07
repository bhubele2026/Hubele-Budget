// Recurring review summary — Fable 5 read of the recurring-charge review queue.
//
// Follows the forecastInsights.ts pattern (Fable 5, DEFAULT_MODEL, 12s
// AbortController, 3-layer fallback). Unlike the fact endpoints, the charges are
// DETECTED CLIENT-SIDE (lib/detectedSubscriptions.ts) and passed in as structured
// facts — so this is a POST. CLAUDE.md §1 still holds: every dollar figure is
// computed in our code (the client detector) and handed to the model; Fable 5
// only writes the language.

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";
import { VOICE_SYSTEM } from "./advisorVoice";

const DEFAULT_MODEL = "claude-fable-5";
const MAX_OUTPUT_TOKENS = 400;
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

export interface ReviewCharge {
  merchant: string;
  annual: number;
  monthly: number;
  cadence: string;
  confidence?: "high" | "medium" | "low";
}

export interface RecurringReviewSummaryRow {
  headline: string;
  bullets: string[];
  summarySource: "ai" | "fallback";
  generatedAt: string;
}

const SYSTEM_PROMPT = `${VOICE_SYSTEM}

TASK: The app has detected NEW recurring charges the household hasn't reviewed yet, and computed each one's cost. Give a short nudge on the review queue — what's here and what's worth a hard look before it keeps billing. Narrate only; never compute or invent a number.

Output requirements:
- Respond with ONLY a JSON object, no markdown fence, no preamble.
- Schema: {"headline": string, "bullets": string[]}.
- headline: <= 9 words — the state of the review queue.
- bullets: 1-3 short strings, each naming a specific charge + its yearly cost from the FACTS, and (where fair) whether it's worth cancelling to speed up debt payoff.

Rules:
- Whole dollars only. Reference ONLY merchants/amounts in the FACTS block.
- Encourage, never shame. If the queue is empty, say so in one line.`;

function formatFactsForPrompt(charges: ReviewCharge[]): string {
  if (charges.length === 0) return "NEW RECURRING CHARGES TO REVIEW: none";
  const lines = ["NEW RECURRING CHARGES TO REVIEW:"];
  const totalAnnual = charges.reduce((s, c) => s + c.annual, 0);
  lines.push(`Total if all kept: ${money(totalAnnual)}/yr`);
  for (const c of charges) {
    lines.push(
      `  ${c.merchant}: ${money(c.annual)}/yr (${money(c.monthly)}/mo, ${c.cadence}${c.confidence ? `, ${c.confidence} confidence` : ""})`,
    );
  }
  return lines.join("\n");
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
  if (!headline) return null;
  return { headline, bullets };
}

export function buildFallbackReviewSummary(charges: ReviewCharge[]): RecurringReviewSummaryRow {
  if (charges.length === 0) {
    return {
      headline: "Nothing new to review",
      bullets: ["No new recurring charges have shown up — you're on top of it."],
      summarySource: "fallback",
      generatedAt: new Date().toISOString(),
    };
  }
  const totalAnnual = charges.reduce((s, c) => s + c.annual, 0);
  const biggest = [...charges].sort((a, b) => b.annual - a.annual)[0];
  const bullets = [
    `${charges.length} new recurring charge${charges.length === 1 ? "" : "s"} — ${money(totalAnnual)}/yr if you keep them all.`,
  ];
  if (biggest)
    bullets.push(`${biggest.merchant} is the biggest at ${money(biggest.annual)}/yr — worth a hard look.`);
  return {
    headline: `${charges.length} new charge${charges.length === 1 ? "" : "s"} to review`,
    bullets,
    summarySource: "fallback",
    generatedAt: new Date().toISOString(),
  };
}

async function callAnthropicWithTimeout(
  charges: ReviewCharge[],
): Promise<{ headline: string; bullets: string[] } | null> {
  const client = getClient();
  if (!client) return null;
  const userPrompt = `FACTS:\n${formatFactsForPrompt(charges)}\n\nWrite the JSON now.`;
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

export async function generateRecurringReviewSummary(
  charges: ReviewCharge[],
): Promise<RecurringReviewSummaryRow> {
  try {
    const llm = await callAnthropicWithTimeout(charges);
    if (llm)
      return {
        headline: llm.headline,
        bullets: llm.bullets,
        summarySource: "ai",
        generatedAt: new Date().toISOString(),
      };
    logger.warn("recurring-review: LLM returned no usable summary, using fallback");
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "recurring-review: LLM call failed, using fallback",
    );
  }
  return buildFallbackReviewSummary(charges);
}
