import { useMemo } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  getListAgentActionsQueryKey,
  getListAgentFindingsQueryKey,
  getListCategorizationReviewQueryKey,
  getListCategoriesQueryKey,
  getListLearnedRulesQueryKey,
  getListPlaidItemsQueryKey,
  useListAgentActions,
  useListAgentFindings,
  useListCategorizationReview,
  useListCategories,
  useListLearnedRules,
  useListPlaidItems,
  type AgentActionList,
  type AgentFindingList,
  type Category,
  type LearnedRule,
  type ListAgentFindingsParams,
  type ListCategorizationReviewParams,
  type PlaidAccount,
  type PlaidItemDetail,
  type ReviewQueue,
} from "@workspace/api-client-react";
import {
  useGetTransactionsLedgerInfinite,
  type GetTransactionsLedgerParams,
  type LedgerPage,
  type LedgerRow,
} from "@workspace/api-client-react/ledger";
import { monthBounds, weekBounds, addDaysISO } from "@workspace/avalanche-core/householdTime";
import { dataState, type DataState } from "@/lib/queryState";
import { readOf, type Read } from "./todayData";
import { TRAIL_CACHE, trailParams } from "./trailQuery";

export { TRAIL_LIMIT, trailParams } from "./trailQuery";

/**
 * ⭐ EVERYTHING ACTIVITY READS, IN ONE PLACE — and the one place its cache
 * options and request shapes live, so a screen, the Today "Handled" section
 * and the nav badge can never name one key with different options (CLAUDE.md
 * §2). Every figure shown is the server's; nothing is worked out here.
 *
 * The ledger is the cursor ledger: 50 rows a page, bounded by from/to, every
 * filter (search, account, needs-filing) applied in SQL.
 */
export const LEDGER_PAGE_SIZE = 50;
export const REVIEW_LIMIT = 20;
export const FINDINGS_LIMIT = 10;

const LEDGER_CACHE = { staleTime: 2 * 60_000, gcTime: 30 * 60_000 } as const;
const LIVE_CACHE = { staleTime: 60_000, gcTime: 10 * 60_000 } as const;
const RULES_CACHE = { staleTime: 5 * 60_000, gcTime: 30 * 60_000 } as const;
const SLOW_CACHE = { staleTime: 30 * 60_000, gcTime: 60 * 60_000 } as const;

export const reviewParams: ListCategorizationReviewParams = { limit: REVIEW_LIMIT };
export const findingsParams: ListAgentFindingsParams = { status: "open", limit: FINDINGS_LIMIT };

// ── the ledger's filters ─────────────────────────────────────────────────────

export type RangeKey = "week" | "month" | "last-month" | "custom";

export interface LedgerFilters {
  range: RangeKey;
  /** Custom range ends, YYYY-MM-DD; either may be empty while being typed. */
  from: string;
  to: string;
  search: string;
  /** `plaid_accounts.id`, or null for the ledger's own account. */
  account: string | null;
  /** Only charges with no category. */
  unfiled: boolean;
}

export const DEFAULT_FILTERS: LedgerFilters = {
  range: "month",
  from: "",
  to: "",
  search: "",
  account: null,
  unfiled: false,
};

/** The household dates a range chip stands for. Calendar arithmetic only. */
export function rangeDates(f: Pick<LedgerFilters, "range" | "from" | "to">, today: string): { from: string; to: string } {
  const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  switch (f.range) {
    case "week":
      return { from: weekBounds(today).start, to: today };
    case "last-month": {
      const lastOfPrev = addDaysISO(monthBounds(today).start, -1);
      const b = monthBounds(lastOfPrev);
      return { from: b.start, to: b.end };
    }
    case "custom":
      if (isDate(f.from) && isDate(f.to)) {
        return f.from <= f.to ? { from: f.from, to: f.to } : { from: f.to, to: f.from };
      }
      // A half-typed custom range keeps showing the month until it is whole.
      return { from: monthBounds(today).start, to: today };
    default:
      return { from: monthBounds(today).start, to: today };
  }
}

/** The ledger request for a set of filters: bounded by dates and a page of 50. */
export function ledgerParams(f: LedgerFilters, today: string): GetTransactionsLedgerParams {
  const { from, to } = rangeDates(f, today);
  const search = f.search.trim();
  return {
    from,
    to,
    limit: LEDGER_PAGE_SIZE,
    ...(search ? { search } : {}),
    ...(f.account ? { account: f.account } : {}),
    ...(f.unfiled ? { uncategorized: "true" } : {}),
  };
}

// ── reads ────────────────────────────────────────────────────────────────────

export interface LedgerRead {
  rows: LedgerRow[];
  first: LedgerPage | undefined;
  state: DataState;
  isFetching: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  fetchNextPage: () => void;
  refetch: () => void;
  updatedAt: string | null;
}

export function useLedger(params: GetTransactionsLedgerParams): LedgerRead {
  // Keyed on the serialised request so an equal filter keeps one query.
  const key = JSON.stringify(params);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stable = useMemo(() => params, [key]);
  const q = useGetTransactionsLedgerInfinite(stable, {
    query: {
      initialPageParam: undefined,
      getNextPageParam: (last: LedgerPage) => last.nextCursor ?? undefined,
      ...LEDGER_CACHE,
    },
  });
  const pages = q.data?.pages;
  const rows = useMemo(() => (pages ?? []).flatMap((p) => p.rows), [pages]);
  return {
    rows,
    first: pages?.[0],
    state: dataState(q),
    isFetching: q.isFetching ?? false,
    isFetchingNextPage: q.isFetchingNextPage,
    hasNextPage: q.hasNextPage ?? false,
    fetchNextPage: () => {
      void q.fetchNextPage();
    },
    refetch: () => {
      void q.refetch();
    },
    updatedAt: q.dataUpdatedAt ? new Date(q.dataUpdatedAt).toISOString() : null,
  };
}

export function useCategoryList(): Read<Category[]> {
  return readOf(useListCategories({ query: { queryKey: getListCategoriesQueryKey(), ...SLOW_CACHE } }));
}

/** Accounts the ledger can be narrowed to: Plaid depository accounts. */
export function usePlaidAccounts(): { accounts: PlaidAccount[]; byId: Map<string, PlaidAccount> } {
  const q = useListPlaidItems({ query: { queryKey: getListPlaidItemsQueryKey(), ...SLOW_CACHE } });
  return useMemo(() => {
    const accounts = ((q.data ?? []) as PlaidItemDetail[]).flatMap((i) => i.accounts ?? []);
    const byId = new Map<string, PlaidAccount>();
    for (const a of accounts) {
      byId.set(a.id, a);
      byId.set(a.accountId, a);
    }
    return { accounts: accounts.filter((a) => a.type === "depository"), byId };
  }, [q.data]);
}

export function useReviewQueue(enabled = true): Read<ReviewQueue> {
  return readOf(
    useListCategorizationReview(reviewParams, {
      query: { queryKey: getListCategorizationReviewQueryKey(reviewParams), ...(enabled ? {} : { enabled: false }), ...LIVE_CACHE },
    }),
  );
}

export function useLearnedRules(): Read<LearnedRule[]> {
  return readOf(useListLearnedRules({ query: { queryKey: getListLearnedRulesQueryKey(), ...RULES_CACHE } }));
}

export function useAgentTrail(): Read<AgentActionList> {
  return readOf(
    useListAgentActions(trailParams, {
      query: { queryKey: getListAgentActionsQueryKey(trailParams), ...TRAIL_CACHE },
    }),
  );
}

export function useAgentFindings(): Read<AgentFindingList> {
  return readOf(
    useListAgentFindings(findingsParams, {
      query: { queryKey: getListAgentFindingsQueryKey(findingsParams), ...LIVE_CACHE },
    }),
  );
}

/**
 * ⭐ THE ACTIVITY BADGE — charges waiting on a person: the review queue's own
 * count plus the spine's `reviewCount`. Both are the server's numbers; this
 * only adds them. The queue read is the same key the Review screen uses.
 */
export function badgeCount(queueTotal: number | null | undefined, spineReviewCount: number | null | undefined): number {
  const n = (queueTotal ?? 0) + (spineReviewCount ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** After a write that moves the queue, the rules or the trail: ask for them again. */
export function invalidateActivity(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: getListCategorizationReviewQueryKey().slice(0, 1) });
  void qc.invalidateQueries({ queryKey: getListLearnedRulesQueryKey() });
  void qc.invalidateQueries({ queryKey: getListAgentActionsQueryKey().slice(0, 1) });
  void qc.invalidateQueries({ queryKey: getListAgentFindingsQueryKey().slice(0, 1) });
}

export function useInvalidateActivity(): () => void {
  const qc = useQueryClient();
  return () => invalidateActivity(qc);
}
