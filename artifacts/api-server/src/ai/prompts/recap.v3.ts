import type { PromptDef } from "./index";
import type { RecapPromptInput } from "./recap.v1";
import { recapV2 } from "./recap.v2";

export { RecapDraft } from "./recap.v2";

// (V3, dashboard refinement — owner-approved 2026-10-09) recap.v2 with the
// cash sentence in the dashboard's words. `availableUntilPayday` is "Checking
// covers $X until <weekday>" everywhere the household reads it (the template,
// this prompt, the dashboard's Room-to-spend subline). "Room in the plan"
// named a different figure on the dashboard, so it is gone. Nothing else
// changes; the validator still gates every number in the final text.

const V2_ROOM =
  "Say the room in the plan, like \"Room in the plan: $1,234 until Fri\", from position.availableUntilPayday and position.paydayWeekday. If position.horizonKind is week_end there is no payday: say \"Room in the plan: $1,234 until Saturday\". Omit it when the figure is null.";
const V3_ROOM =
  "Say what checking covers, like \"Checking covers $1,234 until Fri\", from position.availableUntilPayday and position.paydayWeekday. If position.horizonKind is week_end there is no payday: say \"Checking covers $1,234 until Saturday\". Omit it when the figure is null.";

if (!recapV2.system.includes(V2_ROOM)) {
  // A silent no-op replace would ship v2's words under v3's name.
  throw new Error("recap.v3: recap.v2's cash sentence changed; update V2_ROOM");
}

export const recapV3: PromptDef<RecapPromptInput> = {
  PROMPT_VERSION: "recap.v3",
  system: recapV2.system.replace(V2_ROOM, V3_ROOM),
  build: recapV2.build,
};
