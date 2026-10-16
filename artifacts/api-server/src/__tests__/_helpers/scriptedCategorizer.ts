import Anthropic from "@anthropic-ai/sdk";
import { queueFakeSteps, registerFakeFixture, type FakeStep } from "../../ai/fake";
import type { StructuredCall } from "../../ai/provider";

// (Task 7, V) Test-only. What the categorizer's model "says", scripted per test
// at the provider boundary: `AI_PROVIDER=fake` answers every `categorize` call
// from these steps (`ai/fake`), and the code under test runs unchanged from
// runStructured down. The production provider is never constructed here, and
// `getAnthropic()` refuses a live call under the test runner anyway.
//
//   suggestion    a valid answer: `answer(call)` builds it (see fixtureBy)
//   empty         a valid answer with no results
//   malformed     output that does not decode (unparseable JSON)
//   timeout       the SDK's own APIConnectionTimeoutError
//   api_error     a 500 from the API (InternalServerError)
//   rate_limited  a 429 (RateLimitError)
//
// Every result this drives is "fixture / provider-mocked verification": it
// proves what the app does with each answer, not what the real model answers.

export type ScriptedKind = "suggestion" | "empty" | "malformed" | "timeout" | "api_error" | "rate_limited";
export const SCRIPTED_KINDS: readonly ScriptedKind[] = ["suggestion", "empty", "malformed", "timeout", "api_error", "rate_limited"];

const headers = () => new Headers({ "request-id": "req_fixture" });

/** The step one call gets for a failure kind (a fresh error object per call). */
export function failureStep(kind: Exclude<ScriptedKind, "suggestion" | "empty">): FakeStep {
  switch (kind) {
    case "malformed":
      return { kind: "text", text: '{"results": [{"index": 0, "categoryId": ' };
    case "timeout":
      return { kind: "throw", error: new Anthropic.APIConnectionTimeoutError({ message: "Request timed out." }) };
    case "api_error":
      return {
        kind: "throw",
        error: new Anthropic.InternalServerError(500, { type: "error", error: { type: "api_error", message: "Internal server error" } }, "Internal server error", headers()),
      };
    case "rate_limited":
      return {
        kind: "throw",
        error: new Anthropic.RateLimitError(429, { type: "error", error: { type: "rate_limit_error", message: "Rate limited" } }, "Rate limited", headers()),
      };
  }
}

/**
 * Script the next categorize calls. `suggestion` and `empty` answer every call
 * until `resetFake()`; a failure kind answers the next `times` calls (default
 * 10) and then falls back to whatever is registered.
 */
export function scriptCategorizer(
  kind: ScriptedKind,
  opts: { answer?: (call: StructuredCall) => unknown; times?: number } = {},
): void {
  if (kind === "suggestion") {
    if (!opts.answer) throw new Error("scriptCategorizer('suggestion') needs an answer");
    registerFakeFixture("categorize", opts.answer);
    return;
  }
  if (kind === "empty") {
    registerFakeFixture("categorize", { results: [] });
    return;
  }
  const times = opts.times ?? 10;
  queueFakeSteps("categorize", ...Array.from({ length: times }, () => failureStep(kind)));
}
