import type { AiTask } from "../config";
import type { AiProvider, StructuredCall, StructuredResponse, ToolLoopCall, ToolLoopResponse, ToolLoopTurn } from "../provider";
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

// ── (AI-2) The scripted tool loop ───────────────────────────────────────────
// A script names the tool calls the "model" makes, in order, then its final
// text (a string, or a function of the tool results it saw). Nothing queued:
// the `chat` fixture's text answers with no tool calls.
export interface FakeChatScript {
  calls?: Array<{ name: string; input: unknown }>;
  text: string | ((results: string[]) => string);
  stopReason?: "end_turn" | "refusal" | "max_tokens" | "tool_use";
  /** Usage of each simulated API request (the final one and one per call). */
  usage?: Partial<TokenUsage>;
  /** Throw this instead of answering. */
  error?: unknown;
  /** Wait this long before the final answer (stream and concurrency tests). */
  delayMs?: number;
}
const queuedChats: FakeChatScript[] = [];
/** Every tool loop the fake ran, oldest first (tests read it). */
export const fakeToolLoops: ToolLoopCall[] = [];
export function queueFakeChat(...scripts: FakeChatScript[]): void {
  queuedChats.push(...scripts);
}

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
  queuedChats.length = 0;
  fakeToolLoops.length = 0;
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
  async runTools(call: ToolLoopCall): Promise<ToolLoopResponse> {
    fakeToolLoops.push(call);
    counter += 1;
    const script: FakeChatScript =
      queuedChats.shift() ??
      { text: String((fixtureValue({ task: call.task } as StructuredCall) as { text?: string } | null)?.text ?? "Demo answer.") };
    if (script.error) throw script.error;
    const turns: ToolLoopTurn[] = [];
    const turn = (stopReason: string): void => {
      turns.push({ model: FAKE_MODEL, usage: usageOf(script.usage), requestId: `fake_${counter}_${turns.length + 1}`, stopReason });
    };
    const results: string[] = [];
    const cap = call.maxIterations;
    for (const c of script.calls ?? []) {
      if (turns.length >= cap) break;
      turn("tool_use");
      const tool = call.tools.find((t) => t.name === c.name);
      if (!tool) {
        results.push(JSON.stringify({ error: "unknown_tool" }));
        continue;
      }
      const parsed = tool.inputSchema.safeParse(c.input);
      results.push(parsed.success ? await tool.run(parsed.data) : JSON.stringify({ error: "invalid_input" }));
    }
    if (turns.length >= cap && (script.calls?.length ?? 0) >= cap) {
      return { text: "", stopReason: "tool_use", turns, demo: true };
    }
    if (script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs));
    const text = typeof script.text === "function" ? script.text(results) : script.text;
    const stopReason = script.stopReason ?? "end_turn";
    turn(stopReason);
    if (stopReason !== "refusal" && text) {
      for (let i = 0; i < text.length; i += 24) call.onText?.(text.slice(i, i + 24));
    }
    return { text: stopReason === "refusal" ? "" : text, stopReason, turns, demo: true };
  },
};
