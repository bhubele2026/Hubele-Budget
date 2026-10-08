export interface ToolContext {
  householdId: string;
  /** The household owner's id: the money readers key some rows by it. */
  ownerUserId: string;
  /** The signed-in person asking. */
  actorUserId: string;
  runId: string;
  /** True only when the person's own message asked for the change (the UI sets it). */
  userAskedToChange?: boolean;
}

/** Write tools a single run may call. A runaway loop cannot flood the trail. */
export const MAX_WRITES_PER_RUN = 5;
