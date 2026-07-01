// (#888 — Merchant rename & learn, Phase 1) AI-assisted merchant-name
// suggestion for the rename popover's "✨ Suggest" button.
//
// Given a raw bank description, ask Anthropic for a short, human-friendly
// merchant name. Mirrors the resilience contract of debriefAdvisorSummary:
//   * No API key / disabled / network error / timeout / unparseable →
//     deterministic fallback via cleanMerchant(). The UI MUST always get a
//     usable suggestion.
//   * Results are cached in-process keyed by merchantSignature() so repeated
//     clicks on rows that share a signature don't re-spend tokens.

import Anthropic from "@anthropic-ai/sdk";
import { cleanMerchant, merchantSignature } from "./merchantNameExtract";
import { logger } from "./logger";

// High-volume, mechanical name cleanup — runs on Haiku 4.5 (cheap/fast), tuned
// independently of the advisor/roast reasoning models via CATEGORIZE_MODEL.
const DEFAULT_MODEL = "claude-haiku-4-5";
const MAX_OUTPUT_TOKENS = 60;
const ANTHROPIC_TIMEOUT_MS = 12_000;
const MAX_NAME_LEN = 60;

let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (process.env.ADVISOR_ENABLED === "false") return null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!_client) _client = new Anthropic({ apiKey });
  return _client;
}
function getModel(): string {
  return process.env.CATEGORIZE_MODEL || DEFAULT_MODEL;
}

const SYSTEM_PROMPT = `You clean up messy bank/credit-card transaction descriptions into the short, human-friendly name of the merchant or payee.

Rules:
- Respond with ONLY the name, nothing else. No quotes, no preamble, no punctuation-only output.
- Keep it short (1-4 words). Use normal title case (e.g. "Trader Joe's", "American Express", "Netflix").
- Strip processor noise (ACH, ORIG CO NAME, WEB ID, SEC codes), reference/trace numbers, store numbers, and dates.
- For payroll/ACH credits from an employer, return the employer name.
- For person-to-person transfers (Zelle/Venmo), return the person's name.
- If you truly cannot tell, return the most likely merchant name from the recognizable words.`;

export interface SuggestResult {
  suggestion: string;
  signature: string;
  source: "ai" | "fallback";
}

// In-process cache keyed by signature. Small + unbounded-in-practice (a
// household has a bounded set of merchants); fine for a single server.
const _cache = new Map<string, SuggestResult>();

function sanitizeName(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").trim();
  }
  // Drop wrapping quotes the model sometimes adds.
  s = s.replace(/^["'`]+|["'`]+$/g, "").trim();
  // Collapse whitespace + cap length.
  s = s.replace(/\s+/g, " ").slice(0, MAX_NAME_LEN).trim();
  return s;
}

async function callAnthropicWithTimeout(
  description: string,
): Promise<string | null> {
  const client = getClient();
  if (!client) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ANTHROPIC_TIMEOUT_MS);
  try {
    const res = await client.messages.create(
      {
        model: getModel(),
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Raw description:\n${description}\n\nReturn the clean merchant name now.`,
          },
        ],
      },
      { signal: ctrl.signal },
    );
    const textBlock = res.content.find((c) => c.type === "text");
    if (!textBlock || textBlock.type !== "text") return null;
    const name = sanitizeName(textBlock.text);
    return name.length > 0 ? name : null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Suggest a friendly merchant name for a raw description. Always resolves
 * (never throws) — AI failures fall back to the deterministic cleanMerchant.
 */
export async function suggestMerchantName(
  description: string,
): Promise<SuggestResult> {
  const signature = merchantSignature(description);
  const fallback = cleanMerchant(description);

  if (signature) {
    const cached = _cache.get(signature);
    if (cached) return cached;
  }

  let result: SuggestResult;
  try {
    const ai = await callAnthropicWithTimeout(description);
    result = ai
      ? { suggestion: ai, signature, source: "ai" }
      : { suggestion: fallback, signature, source: "fallback" };
    if (!ai) {
      logger.warn(
        { signature },
        "merchant-suggest: LLM returned no usable name, using fallback",
      );
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), signature },
      "merchant-suggest: LLM call failed, using fallback",
    );
    result = { suggestion: fallback, signature, source: "fallback" };
  }

  // Only cache successful AI results — a fallback should retry the AI later.
  if (signature && result.source === "ai") _cache.set(signature, result);
  return result;
}
