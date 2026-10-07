import { logger } from "../lib/logger";
import type { TokenUsage } from "./types";

// (AI-0) USD per million tokens, Anthropic first-party API, checked
// 2026-10-07 against the official model and pricing tables.
// cacheWrite = 1.25 x input (5-minute TTL — the only TTL this program uses).
// cacheRead: 0.05 x input on claude-opus-5-5 ($0.20), $0.20 on
// claude-sonnet-5-5, 0.1 x input elsewhere.
// A model that is not in this table costs null and logs a warning — the
// ledger never guesses a price.
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const PRICES_USD_PER_MTOK: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

const warned = new Set<string>();

/** A dated snapshot id (`claude-haiku-4-5-20251001`) prices as its alias. */
function priceFor(model: string): ModelPrice | null {
  const direct = PRICES_USD_PER_MTOK[model];
  if (direct) return direct;
  const alias = model.replace(/-\d{8}$/, "");
  return PRICES_USD_PER_MTOK[alias] ?? null;
}

/** Cost of one call in USD, rounded to the ledger's 6 decimals; null when the model has no price. */
export function costUsd(model: string, usage: TokenUsage): number | null {
  const p = priceFor(model);
  if (!p) {
    if (!warned.has(model)) {
      warned.add(model);
      logger.warn({ model }, "AI model has no price in prices.ts — cost recorded as null");
    }
    return null;
  }
  const micro =
    usage.inputTokens * p.input +
    usage.outputTokens * p.output +
    usage.cacheReadTokens * p.cacheRead +
    usage.cacheWriteTokens * p.cacheWrite;
  // tokens x $/MTok / 1e6 = $; round half-up at 1e-6.
  return Math.round(micro) / 1e6;
}
