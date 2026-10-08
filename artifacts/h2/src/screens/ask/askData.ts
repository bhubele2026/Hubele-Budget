import {
  getGetAiConversationQueryKey,
  getGetAiUsageSummaryQueryKey,
  getHealthCheckQueryKey,
  getListAgentProposalsQueryKey,
  getListAiConversationsQueryKey,
  getListMemoryQueryKey,
  getListWishlistQueryKey,
  useGetAiConversation,
  useGetAiUsageSummary,
  useHealthCheck,
  useListAgentProposals,
  useListAiConversations,
  useListCategories,
  useListMemory,
  useListWishlist,
  getListCategoriesQueryKey,
  type HealthStatus,
  type ListAgentProposalsParams,
} from "@workspace/api-client-react";
import { readOf, type Read } from "@/data/todayData";

/**
 * Everything the Ask screens read, with one cache setting per key (CLAUDE.md §2).
 * Nothing is worked out here.
 */
const LIVE = { staleTime: 30_000, gcTime: 10 * 60_000 } as const;
const SLOW = { staleTime: 5 * 60_000, gcTime: 30 * 60_000 } as const;

export const OPEN_PROPOSALS: ListAgentProposalsParams = { status: "proposed" };
export const ALL_PROPOSALS: ListAgentProposalsParams = { status: "all", limit: 50 };
const CONVERSATIONS = { limit: 20 } as const;

export const useAiHealth = (): Read<HealthStatus> =>
  readOf(useHealthCheck({ query: { queryKey: getHealthCheckQueryKey(), staleTime: 5 * 60_000, gcTime: 30 * 60_000 } }));

export const useConversations = () =>
  useListAiConversations(CONVERSATIONS, { query: { queryKey: getListAiConversationsQueryKey(CONVERSATIONS), ...LIVE } });

export const useConversation = (id: string | null) =>
  useGetAiConversation(id ?? "", { query: { queryKey: getGetAiConversationQueryKey(id ?? ""), enabled: id != null, ...LIVE } });

export const useOpenProposals = () =>
  useListAgentProposals(OPEN_PROPOSALS, { query: { queryKey: getListAgentProposalsQueryKey(OPEN_PROPOSALS), ...LIVE } });

export const useAllProposals = () =>
  useListAgentProposals(ALL_PROPOSALS, { query: { queryKey: getListAgentProposalsQueryKey(ALL_PROPOSALS), ...LIVE } });

export const useMemoryList = () => useListMemory({ query: { queryKey: getListMemoryQueryKey(), ...LIVE } });
export const useWishlist = () => useListWishlist({ query: { queryKey: getListWishlistQueryKey(), ...LIVE } });
export const useAiUsage = () => useGetAiUsageSummary({ query: { queryKey: getGetAiUsageSummaryQueryKey(), ...LIVE } });
export const useCategoryNames = () => useListCategories({ query: { queryKey: getListCategoriesQueryKey(), ...SLOW } });

/** Marks every proposal list stale (open and all share the one prefix). */
export const PROPOSALS_PREFIX = ["/api/agent/proposals"] as const;
