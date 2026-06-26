// (#weekly-payoff) Sassy one-line directive for the per-card Amex weekly
// payoff (the "Kill Stack" / Hannah feature).
//
// Follows avalancheAdvisorSummary.ts exactly: same Anthropic client setup,
// same DEFAULT_MODEL, same 12s timeout via AbortController, same fallback
// path. The numbers come from the DETERMINISTIC computeWeeklyPayoff()
// (amexAnchor.ts) — Claude only narrates them in the household voice, never
// inventing an amount. Output is one short directive string.

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";
import { VOICE_SYSTEM, voiceFallback } from "./advisorVoice";
import type { AmexWeeklyPayoff } from "./amexAnchor";

const DEFAULT_MODEL = "claude-sonnet-4-5";
const MAX_OUTPUT_TOKENS = 200;
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
  return `$${Math.round(Number(n) || 0).toLocaleString("en-US")}`;
}

export interface AmexPayoffDirective {
  directive: string;
  source: "ai" | "fallback";
  generatedAt: string;
}

const TASK_PROMPT = `You write ONE short directive for the household's Amex "pay this for last week" card — the thing Hannah looks at to know exactly what to clear.

Output requirements:
- Respond with ONLY the directive text. No JSON, no markdown, no quotes, no preamble.
- ONE or TWO sentences, max ~35 words.
- Name the per-card amounts from the FACTS (Blue / Silver / Gold) and the combined total. Use ONLY amounts present in the FACTS.
- Address Hannah by name. Push her to clear it. Affectionate, blunt, funny.
- If the combined total is $0, make a dry joke about a suspiciously quiet week instead.`;

function formatFacts(payoff: AmexWeeklyPayoff): string {
  const lines: string[] = [];
  lines.push(`Week: ${payoff.weekStart} to ${payoff.weekEnd}`);
  for (const c of payoff.cards) {
    lines.push(
      `${c.brand.toUpperCase()} (${c.name}): charged ${money(c.weekCharges)} across ${c.chargeCount} purchase${c.chargeCount === 1 ? "" : "s"}` +
        (c.topMerchant ? `, biggest was ${c.topMerchant.name} ${money(c.topMerchant.amount)}` : ""),
    );
  }
  lines.push(`Combined charged this week: ${money(payoff.combinedWeekCharges)}`);
  return lines.join("\n");
}

async function callAnthropicWithTimeout(
  payoff: AmexWeeklyPayoff,
): Promise<string | null> {
  const client = getClient();
  if (!client) return null;
  const userPrompt = `FACTS:\n${formatFacts(payoff)}\n\nWrite the directive now.`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ANTHROPIC_TIMEOUT_MS);
  try {
    const res = await client.messages.create(
      {
        model: getModel(),
        max_tokens: MAX_OUTPUT_TOKENS,
        system: `${VOICE_SYSTEM}\n\n${TASK_PROMPT}`,
        messages: [{ role: "user", content: userPrompt }],
      },
      { signal: ctrl.signal },
    );
    const textBlock = res.content.find((c) => c.type === "text");
    if (!textBlock || textBlock.type !== "text") return null;
    const text = textBlock.text.trim().replace(/^["']|["']$/g, "");
    return text.length > 0 ? text : null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generate the sassy weekly-payoff directive. Two-layer fallback: AI line →
 * deterministic in-voice line from voiceFallback("amexPayoff", …). Pure
 * computation + AI call — does NOT persist.
 */
export async function generateAmexPayoffDirective(
  payoff: AmexWeeklyPayoff,
): Promise<AmexPayoffDirective> {
  try {
    const line = await callAnthropicWithTimeout(payoff);
    if (line) {
      return { directive: line, source: "ai", generatedAt: new Date().toISOString() };
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "amex-payoff-advisor: LLM call failed, using fallback",
    );
  }
  return {
    directive: voiceFallback("amexPayoff", {
      cards: payoff.cards.map((c) => ({ brand: c.brand, weekCharges: c.weekCharges })),
      combinedWeekCharges: payoff.combinedWeekCharges,
      weekStart: payoff.weekStart,
    }),
    source: "fallback",
    generatedAt: new Date().toISOString(),
  };
}
