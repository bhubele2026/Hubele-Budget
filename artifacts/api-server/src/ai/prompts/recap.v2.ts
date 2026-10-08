import type { PromptDef } from "./index";
import { recapV1, type RecapPromptInput } from "./recap.v1";

export { RecapDraft } from "./recap.v1";

// (V2) recap.v1 plus the one-action line. The action is chosen by code
// (recap/action.ts) and rides in facts.action; the model repeats it verbatim.
// Code appends it when a draft leaves it out, and the validator still gates
// every number in the final text.

const system = recapV1.system
  .replace(
    "Say what is free until payday, like \"$1,234 free until payday (Fri)\", from position.availableUntilPayday and position.paydayWeekday. If position.horizonKind is week_end there is no payday: say free through Saturday. Omit it when the figure is null.",
    "Say the room in the plan, like \"Room in the plan: $1,234 until Fri\", from position.availableUntilPayday and position.paydayWeekday. If position.horizonKind is week_end there is no payday: say \"Room in the plan: $1,234 until Saturday\". Omit it when the figure is null.",
  )
  .replace(
    "- Give at most ONE next step, and only the one named by nextStep (review, or a bill due tomorrow). If nextStep is null, give none.",
    "- Include facts.action.text verbatim, once, right after the plan sentence. It is the one action; add no other next step. If facts.action is null, give none.",
  );

export const recapV2: PromptDef<RecapPromptInput> = {
  PROMPT_VERSION: "recap.v2",
  system,
  build: recapV1.build,
};
