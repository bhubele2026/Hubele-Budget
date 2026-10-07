import type { AiTask } from "../config";
import type { StructuredCall } from "../provider";

// (AI-0) What the fake provider answers when nothing was scripted. Every
// fixture is deterministic and says plainly that no model ran, so a screen
// that shows it can label it "Demo". These are placeholders: each business
// package registers a fixture that matches its own schema
// (`registerFakeFixture`) next to its prompt.

export type FakeFixture = unknown | ((call: StructuredCall) => unknown);

export const DEFAULT_FAKE_FIXTURES: Readonly<Record<AiTask, FakeFixture>> = {
  categorize: {
    categoryId: null,
    confidence: "low",
    isTransfer: false,
    rationale: "Demo answer. No model was called.",
  },
  chat: { text: "This is a demo answer. Turn on AI to ask real questions." },
  recap: { text: "Demo recap. No model was called.", facts_used: [] },
  receipt: { merchant: null, total: null, date: null, lineItems: [] },
  sms_question: { text: "Demo reply. No model was called." },
  eval_judge: { score: 0, reason: "Demo judge. No model was called." },
};
