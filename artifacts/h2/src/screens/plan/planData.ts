import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  getGetAvalancheExtraQueryKey,
  getGetAvalancheSettingsQueryKey,
  getGetBillsSummaryQueryKey,
  getGetBudgetMonthQueryKey,
  getGetDebtPlanQueryKey,
  getGetMeQueryKey,
  getGetMoneyPositionQueryKey,
  getListAllowancePlansQueryKey,
  getListCategoriesQueryKey,
  getListDebtsQueryKey,
  getListMembersQueryKey,
  getListRecurringItemsQueryKey,
  useGetAvalancheExtra,
  useGetAvalancheSettings,
  useGetBillsSummary,
  useGetBudgetMonth,
  useGetDebtPlan,
  useGetMe,
  useGetMoneyPosition,
  useListAllowancePlans,
  useListCategories,
  useListDebts,
  useListMembers,
  useListRecurringItems,
  type AllowancePlans,
  type AvalancheExtra,
  type AvalancheSettings,
  type BillsSummary,
  type BudgetMonthDetail,
  type Category,
  type Debt,
  type DebtPlan,
  type MeResponse,
  type Member,
  type MoneyPosition,
  type RecurringItem,
} from "@workspace/api-client-react";
import { readOf, type Read } from "@/data/todayData";
import { useSpine, type SpineRead } from "@/data/useSpine";

/**
 * ⭐ EVERYTHING THE PLAN SCREENS READ, IN ONE PLACE, with the cache options the
 * keys carry — one set per key, so a screen and anything that warms the key
 * can never disagree (CLAUDE.md §2). Every figure is read as the server sent
 * it; nothing is worked out here.
 */
const POSITION_CACHE = { staleTime: 60_000, gcTime: 30 * 60_000 } as const;
const PLAN_CACHE = { staleTime: 5 * 60_000, gcTime: 30 * 60_000 } as const;
const SLOW_CACHE = { staleTime: 30 * 60_000, gcTime: 60 * 60_000 } as const;
const MONTH_CACHE = { staleTime: 2 * 60_000, gcTime: 30 * 60_000 } as const;

export interface WeekData {
  spine: SpineRead;
  plans: Read<AllowancePlans>;
  position: Read<MoneyPosition>;
  me: Read<MeResponse>;
  members: Read<Member[]>;
}

export function usePlanWeekData(): WeekData {
  const spine = useSpine();
  const plans = useListAllowancePlans({ query: { queryKey: getListAllowancePlansQueryKey(), ...PLAN_CACHE } });
  const position = useGetMoneyPosition({ query: { queryKey: getGetMoneyPositionQueryKey(), ...POSITION_CACHE } });
  const me = useGetMe({ query: { queryKey: getGetMeQueryKey(), ...SLOW_CACHE } });
  // Only the owner may list members; a member's request would be a 403.
  const members = useListMembers({
    query: { queryKey: getListMembersQueryKey(), enabled: me.data?.isOwner === true, ...SLOW_CACHE },
  });
  return { spine, plans: readOf(plans), position: readOf(position), me: readOf(me), members: readOf(members) };
}

export interface BillsData {
  items: Read<RecurringItem[]>;
  summary: Read<BillsSummary>;
  categories: Read<Category[]>;
}

export function usePlanBillsData(): BillsData {
  const items = useListRecurringItems({ query: { queryKey: getListRecurringItemsQueryKey(), ...SLOW_CACHE } });
  const summary = useGetBillsSummary(undefined, { query: { queryKey: getGetBillsSummaryQueryKey(), ...PLAN_CACHE } });
  const categories = useListCategories({ query: { queryKey: getListCategoriesQueryKey(), ...SLOW_CACHE } });
  return { items: readOf(items), summary: readOf(summary), categories: readOf(categories) };
}

export interface DebtData {
  spine: SpineRead;
  plan: Read<DebtPlan>;
  settings: Read<AvalancheSettings>;
  extra: Read<AvalancheExtra>;
  debts: Read<Debt[]>;
}

export function usePlanDebtData(): DebtData {
  const spine = useSpine();
  const plan = useGetDebtPlan({ query: { queryKey: getGetDebtPlanQueryKey(), ...PLAN_CACHE } });
  const settings = useGetAvalancheSettings({ query: { queryKey: getGetAvalancheSettingsQueryKey(), ...SLOW_CACHE } });
  const extra = useGetAvalancheExtra({ query: { queryKey: getGetAvalancheExtraQueryKey(), ...SLOW_CACHE } });
  const debts = useListDebts({ query: { queryKey: getListDebtsQueryKey(), ...SLOW_CACHE } });
  return { spine, plan: readOf(plan), settings: readOf(settings), extra: readOf(extra), debts: readOf(debts) };
}

export interface CategoriesData {
  month: Read<BudgetMonthDetail>;
}

export function usePlanCategoriesData(monthStart: string): CategoriesData {
  const month = useGetBudgetMonth(monthStart, {
    query: { queryKey: getGetBudgetMonthQueryKey(monthStart), ...MONTH_CACHE },
  });
  return { month: readOf(month) };
}

/**
 * What a Plan write marks stale, on top of the spine and reports the app-wide
 * rule already covers: the lists it edits and everything that is derived from
 * them (the bills summary, the debt plan, the budget months, the forecast, the
 * allowance plans and the money position). `invalidateQueries` refetches only
 * what is mounted, so this costs almost nothing.
 */
const PLAN_KEY_PREFIXES = [
  "/api/allowance-plans",
  "/api/recurring-items",
  "/api/bills",
  "/api/debts",
  "/api/debt-plan",
  "/api/avalanche",
  "/api/budget",
  "/api/forecast",
  "/api/money",
] as const;

export function invalidatePlanWrite(client: QueryClient): void {
  void client.invalidateQueries({
    predicate: (q) => {
      const k = q.queryKey[0];
      return typeof k === "string" && PLAN_KEY_PREFIXES.some((p) => k === p || k.startsWith(`${p}/`));
    },
  });
}

/** For screens: the query client plus the one invalidation they all call after a write. */
export function usePlanInvalidate(): () => void {
  const qc = useQueryClient();
  return () => invalidatePlanWrite(qc);
}
