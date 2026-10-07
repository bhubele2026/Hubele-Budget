import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicProvider } from "./anthropicProvider";
import { fakeProvider } from "./fake";
import type { AiProvider, AiProviderName } from "./provider";

// (AI-0) Which provider answers, and whether AI may run at all.
//
// AI_PROVIDER=anthropic|fake picks explicitly. Unset: `anthropic` when
// ANTHROPIC_API_KEY exists, else `fake` outside production (demo mode) and
// `anthropic` — unconfigured, so off — in production.
//
// isAiEnabled() = AI_ENABLED === "true" AND the provider is configured AND
// no global pause. Per-task on/off (ai_task_config) and per-household pause
// (ai_budget.paused_until) are checked by runStructured / assertBudget.

const isProd = () => process.env.NODE_ENV === "production";

export function getProviderName(): AiProviderName {
  const explicit = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (explicit === "anthropic" || explicit === "fake") return explicit;
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return isProd() ? "anthropic" : "fake";
}

export function isProviderConfigured(): boolean {
  return getProviderName() === "fake" || !!process.env.ANTHROPIC_API_KEY;
}

// Global kill switch: env AI_PAUSED=true, or an in-process pause set by ops.
let pausedUntilMs: number | null = null;

export function pauseAiGlobally(untilMs: number | null): void {
  pausedUntilMs = untilMs;
}

export function isGloballyPaused(nowMs: number = Date.now()): boolean {
  if (process.env.AI_PAUSED === "true") return true;
  return pausedUntilMs !== null && nowMs < pausedUntilMs;
}

export function isAiEnabled(): boolean {
  return process.env.AI_ENABLED === "true" && isProviderConfigured() && !isGloballyPaused();
}

export function getAiStatus(): { enabled: boolean; configured: boolean; provider: AiProviderName } {
  return { enabled: isAiEnabled(), configured: isProviderConfigured(), provider: getProviderName() };
}

let client: Anthropic | null = null;

/** The one Anthropic client. Throws when there is no key, or under vitest without AI_LIVE_TESTS=1. */
export function getAnthropic(): Anthropic {
  if ((process.env.VITEST || process.env.NODE_ENV === "test") && process.env.AI_LIVE_TESTS !== "1") {
    throw new Error("Refusing a live Anthropic call under the test runner (set AI_LIVE_TESTS=1 to allow)");
  }
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    // Per-call timeout/maxRetries come from the task config (ai/config.ts).
    client = new Anthropic({ apiKey });
  }
  return client;
}

const anthropicProvider = createAnthropicProvider(getAnthropic);

export function getProvider(): AiProvider {
  return getProviderName() === "fake" ? fakeProvider : anthropicProvider;
}

/** Tests only: forget the client and any global pause. */
export function _resetAiClientForTests(): void {
  client = null;
  pausedUntilMs = null;
}
