import type { QueryClient } from "@tanstack/react-query";
import {
  getBillsSummary,
  getGetBillsSummaryQueryKey,
  getGetMoneyPositionQueryKey,
  getGetSettingsQueryKey,
  getGetSpineQueryKey,
  getListAllowancePlansQueryKey,
  getListCategoriesQueryKey,
  getMoneyPosition,
  getSpine,
  listAllowancePlans,
  listCategories,
  useGetBillsSummary,
  useListAgentActions,
  getListAgentActionsQueryKey,
  useGetMoneyPosition,
  useGetSettings,
  useListAllowancePlans,
  useListCategories,
  type AgentActionList,
  type AllowancePlans,
  type BillsSummary,
  type Category,
  type MoneyPosition,
  type Settings,
} from "@workspace/api-client-react";
import {
  getGetTransactionsLedgerQueryKey,
  getTransactionsLedger,
  useGetTransactionsLedger,
  type GetTransactionsLedgerParams,
  type LedgerPage,
} from "@workspace/api-client-react/ledger";
import { addDaysISO, householdToday } from "@workspace/avalanche-core/householdTime";
import { readAuthHint } from "@/lib/authHint";
import { dataState, type DataState } from "@/lib/queryState";
import { useSpine, type SpineRead } from "./useSpine";
import { TRAIL_CACHE, trailParams } from "./trailQuery";

/**
 * ⭐ EVERYTHING TODAY READS, IN ONE PLACE — and the one place the cache
 * options live, so the screen's hooks and the idle prefetch can never name
 * the same key with different options (CLAUDE.md §2: no duplicate keys).
 *
 * Every figure Today shows comes from the spine or from one of these generated
 * hooks. Nothing is worked out in the browser.
 */
export interface Read<T> {
  data: T | undefined;
  state: DataState;
  isFetching: boolean;
  refetch: () => void;
}

interface QueryShape<T> {
  data: T | undefined;
  isFetching?: boolean;
  isLoadingError?: boolean;
  isRefetchError?: boolean;
  isPlaceholderData?: boolean;
  refetch: () => unknown;
}

export function readOf<T>(q: QueryShape<T>): Read<T> {
  return {
    data: q.data,
    state: dataState(q),
    isFetching: q.isFetching ?? false,
    refetch: () => {
      void q.refetch();
    },
  };
}

/** Fresh as long as the spine is: they are the same position, read two ways. */
const POSITION_CACHE = { staleTime: 60_000, gcTime: 30 * 60_000 } as const;
const BILLS_CACHE = { staleTime: 5 * 60_000, gcTime: 30 * 60_000 } as const;
const LEDGER_CACHE = { staleTime: 2 * 60_000, gcTime: 30 * 60_000 } as const;
const SLOW_CACHE = { staleTime: 30 * 60_000, gcTime: 60 * 60_000 } as const;

/** Yesterday and today, newest first, eight rows at most. */
export const ACTIVITY_ROWS = 8;
export function activityParams(today: string): GetTransactionsLedgerParams {
  return { from: addDaysISO(today, -1), to: today, limit: ACTIVITY_ROWS };
}

export interface TodayData {
  spine: SpineRead;
  position: Read<MoneyPosition>;
  plans: Read<AllowancePlans>;
  settings: Read<Settings>;
  bills: Read<BillsSummary>;
  ledger: Read<LedgerPage>;
  categories: Read<Category[]>;
  /** What H2 handled on its own; Today shows the last four. Same key as Activity's trail. */
  trail: Read<AgentActionList>;
  /** One row of this week's uncategorized charges: only its `matchingCount` is read. */
  unfiled: Read<LedgerPage>;
}

/**
 * This week's charges with no category, one row, for the count. Bounded by the
 * position's own week; asked for only when the position says something needs
 * filing, so a household with nothing to file makes no extra request.
 */
export function unfiledParams(weekStart: string | undefined, weekEnd: string | undefined): GetTransactionsLedgerParams {
  return { from: weekStart, to: weekEnd, limit: 1, uncategorized: "true" };
}

export function useTodayData(today: string): TodayData {
  const spine = useSpine();
  const position = useGetMoneyPosition({
    query: { queryKey: getGetMoneyPositionQueryKey(), ...POSITION_CACHE },
  });
  const plans = useListAllowancePlans({
    query: { queryKey: getListAllowancePlansQueryKey(), ...SLOW_CACHE },
  });
  const settings = useGetSettings({
    query: { queryKey: getGetSettingsQueryKey(), ...SLOW_CACHE },
  });
  const bills = useGetBillsSummary(undefined, {
    query: { queryKey: getGetBillsSummaryQueryKey(), ...BILLS_CACHE },
  });
  const params = activityParams(today);
  const ledger = useGetTransactionsLedger(params, {
    query: { queryKey: getGetTransactionsLedgerQueryKey(params), ...LEDGER_CACHE },
  });
  const categories = useListCategories({
    query: { queryKey: getListCategoriesQueryKey(), ...SLOW_CACHE },
  });
  const trail = useListAgentActions(trailParams, {
    query: { queryKey: getListAgentActionsQueryKey(trailParams), ...TRAIL_CACHE },
  });
  const pos = position.data;
  const needsFiling = Number(pos?.needsClassificationWeek ?? 0) > 0 && Boolean(pos?.weekStart && pos?.weekEnd);
  const unfiledQ = unfiledParams(pos?.weekStart, pos?.weekEnd);
  const unfiled = useGetTransactionsLedger(unfiledQ, {
    query: { queryKey: getGetTransactionsLedgerQueryKey(unfiledQ), enabled: needsFiling, ...LEDGER_CACHE },
  });
  return {
    spine,
    position: readOf(position),
    plans: readOf(plans),
    settings: readOf(settings),
    bills: readOf(bills),
    ledger: readOf(ledger),
    categories: readOf(categories),
    trail: readOf(trail),
    unfiled: readOf(unfiled),
  };
}

/**
 * Once the spine is in, and the browser is idle, warm everything else Today
 * reads, so the sections below the hero fill from cache. Only for a browser
 * that has been signed in before (the same hint as the spine prefetch).
 * Every request is the same key and options the screen's hooks use.
 */
export function prefetchTodayOnIdle(client: QueryClient, now: Date = new Date()): void {
  if (typeof window === "undefined" || !readAuthHint()) return;
  const params = activityParams(householdToday(now));
  const warm = () => {
    const go = (p: Promise<unknown>) => void p.catch(() => {});
    go(client.prefetchQuery({ queryKey: getGetMoneyPositionQueryKey(), queryFn: ({ signal }) => getMoneyPosition({ signal }), ...POSITION_CACHE }));
    go(client.prefetchQuery({ queryKey: getGetBillsSummaryQueryKey(), queryFn: ({ signal }) => getBillsSummary(undefined, { signal }), ...BILLS_CACHE }));
    go(client.prefetchQuery({ queryKey: getGetTransactionsLedgerQueryKey(params), queryFn: ({ signal }) => getTransactionsLedger(params, { signal }), ...LEDGER_CACHE }));
    go(client.prefetchQuery({ queryKey: getListAllowancePlansQueryKey(), queryFn: ({ signal }) => listAllowancePlans({ signal }), ...SLOW_CACHE }));
    go(client.prefetchQuery({ queryKey: getListCategoriesQueryKey(), queryFn: ({ signal }) => listCategories({ signal }), ...SLOW_CACHE }));
  };
  const idle = (cb: () => void) =>
    typeof window.requestIdleCallback === "function"
      ? window.requestIdleCallback(cb, { timeout: 2000 })
      : window.setTimeout(cb, 300);
  // Joins the spine request already in flight (same key), then waits for idle.
  client
    .fetchQuery({ queryKey: getGetSpineQueryKey(), queryFn: ({ signal }) => getSpine({ signal }), staleTime: 60_000, retry: false })
    .catch(() => {})
    .finally(() => idle(warm));
}
