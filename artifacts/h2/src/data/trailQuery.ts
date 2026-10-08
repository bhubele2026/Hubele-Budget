import type { ListAgentActionsParams } from "@workspace/api-client-react";

/**
 * The agent trail's request and cache options, shared by Today's "Handled"
 * section and Activity's "Handled by H2": one key, one set of options, so the
 * two can never fetch the same list twice (CLAUDE.md §2).
 */
export const TRAIL_LIMIT = 10;
export const trailParams: ListAgentActionsParams = { limit: TRAIL_LIMIT };
export const TRAIL_CACHE = { staleTime: 60_000, gcTime: 10 * 60_000 } as const;
