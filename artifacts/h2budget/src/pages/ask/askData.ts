import { useMemo } from "react";
import {
  getGetAiConversationQueryKey,
  getHealthCheckQueryKey,
  getListAgentProposalsQueryKey,
  getListAiConversationsQueryKey,
  getListMemoryQueryKey,
  useGetAiConversation,
  useHealthCheck,
  useListAgentProposals,
  useListAiConversations,
  useListMemory,
  type ListAgentProposalsParams,
} from "@workspace/api-client-react/features";
import { getListCategoriesQueryKey, useListCategories } from "@workspace/api-client-react";

/**
 * (F8) Everything the Ask screens read, from the `features` client, with one
 * cache setting per key (CLAUDE.md §2). Ported from h2's `ask/askData.ts`.
 * Nothing is worked out here.
 */
const LIVE = { staleTime: 30_000, gcTime: 10 * 60_000 } as const;
const SLOW = { staleTime: 30 * 60_000, gcTime: 60 * 60_000 } as const;

export const OPEN_PROPOSALS: ListAgentProposalsParams = { status: "proposed" };
export const ALL_PROPOSALS: ListAgentProposalsParams = { status: "all", limit: 50 };
export const CONVERSATIONS = { limit: 20 } as const;

/** Marks every proposal list stale (open and all share the one prefix). */
export const PROPOSALS_PREFIX = ["/api/agent/proposals"] as const;

export const useAiHealth = () =>
  useHealthCheck({ query: { queryKey: getHealthCheckQueryKey(), staleTime: 5 * 60_000, gcTime: 30 * 60_000 } });

export const useConversations = () =>
  useListAiConversations(CONVERSATIONS, {
    query: { queryKey: getListAiConversationsQueryKey(CONVERSATIONS), ...LIVE },
  });

export const useConversation = (id: string | null) =>
  useGetAiConversation(id ?? "", {
    query: { queryKey: getGetAiConversationQueryKey(id ?? ""), enabled: id != null, ...LIVE },
  });

export const useOpenProposals = () =>
  useListAgentProposals(OPEN_PROPOSALS, {
    query: { queryKey: getListAgentProposalsQueryKey(OPEN_PROPOSALS), ...LIVE },
  });

export const useAllProposals = () =>
  useListAgentProposals(ALL_PROPOSALS, {
    query: { queryKey: getListAgentProposalsQueryKey(ALL_PROPOSALS), ...LIVE },
  });

export const useMemoryList = () => useListMemory({ query: { queryKey: getListMemoryQueryKey(), ...LIVE } });

/** Category id → name, for a proposal that files a charge. */
export function useCategoryNames(): ReadonlyMap<string, string> {
  const cats = useListCategories({ query: { queryKey: getListCategoriesQueryKey(), ...SLOW } });
  return useMemo(() => new Map((cats.data ?? []).map((c) => [c.id, c.name] as const)), [cats.data]);
}
