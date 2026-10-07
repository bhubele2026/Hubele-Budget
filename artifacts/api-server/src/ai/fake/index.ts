import type { AiTask } from "../config";
import type { AiProvider, StructuredCall, StructuredResponse } from "../provider";
import type { TokenUsage } from "../types";
import { DEFAULT_FAKE_FIXTURES, type FakeFixture } from "./fixtures";

// (AI-0) The deterministic provider. Used whenever AI_PROVIDER=fake (the
// default outside production when no key is set) and by every test. It
// answers from a per-task fixture, or from steps a test queued.

export type FakeStep =
  | { kind: "ok"; value: unknown; usage?: Partial<TokenUsage>; model?: string }
  /** Raw output text; decodes to JSON if it can, else parsed = null. */
  | { kind: "text"; text: string; usage?: Partial<TokenUsage> }
  | { kind: "refusal"; usage?: Partial<TokenUsage> }
  | { kind: "max_tokens"; usage?: Partial<TokenUsage> }
  /** Throw this (use the SDK's own error classes to exercise the mapping). */
  | { kind: "throw"; error: unknown };

export const FAKE_MODEL = "fake";

const queued = new Map<AiTask, FakeStep[]>();
const registered = new Map<AiTask, FakeFixture>();
/** Every call the fake answered, oldest first (tests read it). */
export const fakeCalls: StructuredCall[] = [];
let counter = 0;

export function queueFakeSteps(task: AiTask, ...steps: FakeStep[]): void {
  queued.set(task, [...(queued.get(task) ?? []), ...steps]);
}

/** Register the answer a task gives when nothing is queued: a value, or a function of the call. */
export function registerFakeFixture(task: AiTask, fixture: (call: StructuredCall) => unknown): void;
export function registerFakeFixture(task: AiTask, fixture: FakeFixture): void;
export function registerFakeFixture(task: AiTask, fixture: FakeFixture): void {
  registered.set(task, fixture);
}

export function resetFake(): void {
  queued.clear();
  registered.clear();
  fakeCalls.length = 0;
}

function usageOf(u?: Partial<TokenUsage>): TokenUsage {
  return {
    inputTokens: u?.inputTokens ?? 0,
    outputTokens: u?.outputTokens ?? 0,
    cacheWriteTokens: u?.cacheWriteTokens ?? 0,
    cacheReadTokens: u?.cacheReadTokens ?? 0,
  };
}

function fixtureValue(call: StructuredCall): unknown {
  const f = registered.has(call.task) ? registered.get(call.task) : DEFAULT_FAKE_FIXTURES[call.task];
  return typeof f === "function" ? (f as (c: StructuredCall) => unknown)(call) : f;
}

export const fakeProvider: AiProvider = {
  name: "fake",
  async callStructured(call: StructuredCall): Promise<StructuredResponse> {
    fakeCalls.push(call);
    counter += 1;
    const step: FakeStep = queued.get(call.task)?.shift() ?? { kind: "ok", value: fixtureValue(call) };
    const base = { requestId: `fake_${counter}`, demo: true, model: FAKE_MODEL };
    switch (step.kind) {
      case "throw":
        throw step.error;
      case "ok":
        // Round-trip through JSON so the fake hands back what a wire would.
        return {
          ...base,
          model: step.model ?? FAKE_MODEL,
          parsed: JSON.parse(JSON.stringify(step.value ?? null)),
          parseError: null,
          stopReason: "end_turn",
          usage: usageOf(step.usage),
        };
      case "text": {
        let parsed: unknown = null;
        let parseError: string | null = null;
        try {
          parsed = JSON.parse(step.text);
        } catch (err) {
          parseError = err instanceof Error ? err.message : String(err);
        }
        return { ...base, parsed, parseError, stopReason: "end_turn", usage: usageOf(step.usage) };
      }
      case "refusal":
        return { ...base, parsed: null, parseError: null, stopReason: "refusal", usage: usageOf(step.usage) };
      case "max_tokens":
        return { ...base, parsed: null, parseError: "output cut off", stopReason: "max_tokens", usage: usageOf(step.usage) };
    }
  },
};
