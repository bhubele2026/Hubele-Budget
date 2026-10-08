// (PR-A) The MODEL stage is an interface only in this package. AI-1 plugs the
// real one in; until then `NullModelStage` decides nothing and the batch hands
// back the ambiguous ids. Whatever a model returns is validated by code before
// any write (CLAUDE.md §1): its category must be one of the household's, its
// confidence is banded like any other stage, and it never writes `is_transfer`.
import type { EngineContext, EngineRow, StageResult } from "./types";

export interface ModelStage {
  readonly name: string;
  decide(
    householdId: string,
    rows: readonly EngineRow[],
    ctx: EngineContext,
  ): Promise<Map<string, StageResult>>;
}

export class NullModelStage implements ModelStage {
  readonly name = "null";
  async decide(): Promise<Map<string, StageResult>> {
    return new Map();
  }
}
