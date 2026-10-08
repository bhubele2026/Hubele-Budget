import type { AiTask } from "../config";
import type { StructuredCall } from "../provider";

// (AI-0) What the fake provider answers when nothing was scripted. Every
// fixture is deterministic and says plainly that no model ran, so a screen
// that shows it can label it "Demo". These are placeholders: each business
// package registers a fixture that matches its own schema
// (`registerFakeFixture`) next to its prompt.

function demoCategorize(call: StructuredCall): unknown {
  try {
    const first = call.messages[0]?.content;
    const doc = JSON.parse(typeof first === "string" ? first : "{}") as {
      categories?: Array<{ id: string; name: string }>;
      charges?: Array<{ index: number; priors?: Array<{ categoryName: string }> }>;
    };
    const cats = doc.categories ?? [];
    return {
      results: (doc.charges ?? []).map((c) => {
        const hit = cats.find((k) => k.name === c.priors?.[0]?.categoryName);
        return {
          index: c.index,
          categoryId: (hit ?? cats[0])?.id,
          confidence: hit ? "medium" : "low",
          isTransfer: false,
          recurringGuess: null,
          splitSuggestion: null,
          rationale: "Demo answer. No model was called.",
        };
      }),
    };
  } catch {
    return { results: [] };
  }
}

export type FakeFixture = unknown | ((call: StructuredCall) => unknown);

export const DEFAULT_FAKE_FIXTURES: Readonly<Record<AiTask, FakeFixture>> = {
  // (AI-1) Reads the call's own JSON: a charge with a prior is filed where the
  // household filed it before (medium); every other charge gets the first
  // category at low confidence, which the engine only queues.
  categorize: demoCategorize,
  chat: { text: "This is a demo answer. Turn on AI to ask real questions." },
  recap: { text: "Demo recap. No model was called.", factsUsed: [] },
  receipt: { merchant: null, total: null, date: null, lineItems: [] },
  sms_question: { text: "Demo reply. No model was called." },
  eval_judge: { score: 0, reason: "Demo judge. No model was called." },
};
