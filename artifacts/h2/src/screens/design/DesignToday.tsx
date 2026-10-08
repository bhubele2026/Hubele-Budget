import type {
  AgentActionList,
  AllowancePlans,
  BillsSummary,
  Category,
  MoneyPosition,
  Settings,
  Spine,
} from "@workspace/api-client-react";
import type { LedgerPage } from "@workspace/api-client-react/ledger";
import type { Read, TodayData } from "@/data/todayData";
import { Note } from "@/kit/Note";
import { TodayView } from "@/screens/today/Today";

/**
 * ⭐ /design/today — TODAY ON MADE-UP DATA, for looking at the composition
 * without signing in. Public, lazy, no network: every figure below is
 * invented, fixed to one day, and labelled "sample" at the top.
 */
const NOW = new Date("2026-10-07T15:00:00Z"); // Wednesday, 10:00 in Chicago

const SPINE = {
  asOf: "2026-10-07T14:59:00Z",
  bank: {
    balance: "12345.67",
    asOfDate: "2026-10-07T14:48:00Z",
    source: "plaid",
    lastContactAt: "2026-10-07T14:48:00Z",
    lastFailureAt: null,
    stale: false,
    staleReason: null,
  },
  spentMonth: 1890.12,
  spentWeek: 412.4,
  nextBill: { name: "Electric", amount: "142.18", dueDate: "2026-10-08" },
  billsDueCount: 3,
  forecast: { lowPoint: "800.00", lowPointDate: "2026-10-20", runwayDays: null, cashBuffer: "500.00", status: "ready" },
  debt: { payoffPct: 41.3 },
  reviewCount: 2,
  position: {
    safeToSpendNow: "144.50",
    remainingWeek: "144.50",
    availableUntilPayday: "2124.50",
    paydayDate: "2026-10-09",
    horizonKind: "payday",
    withinPlan: "yes",
    confidence: "estimated",
    degraded: false,
  },
} as Spine;

const POSITION = {
  todayISO: "2026-10-07",
  status: "ok",
  paydayDate: "2026-10-09",
  payday: { itemId: "pay", label: "Paycheck", amount: "2000.00" },
  horizon: { kind: "payday", endDate: "2026-10-09", lastDay: "2026-10-09" },
  lowestUntilPayday: "2624.50",
  lowestUntilPaydayDate: "2026-10-08",
  committedUntilPayday: "340.00",
  cashBuffer: "500.00",
  reservesHeld: "0.00",
  availableUntilPayday: "2124.50",
  weekStart: "2026-10-04",
  weekEnd: "2026-10-10",
  weekCap: "250.00",
  spentWeekDiscretionary: "105.50",
  needsClassificationWeek: "25.50",
  unplannedWeek: "40.00",
  monthlyWeek: "30.00",
  remainingWeek: "144.50",
  paceAllowedToday: "142.86",
  withinPlan: "yes",
  safeToSpendNow: "144.50",
  confidence: "estimated",
  estimates: [{ itemId: "electric", label: "Electric", amount: "-340.00", date: "2026-10-08" }],
  assumptions: ["Available credit is not counted.", "Bank data from Oct 7.", "Bills due on payday are counted before the paycheck."],
  degraded: false,
  degradedReason: null,
} as unknown as MoneyPosition;

const PLANS = {
  plans: [
    { id: "p1", memberUserId: null, period: "weekly", amount: "250.00", effectiveFrom: "2026-09-27", source: "owner", derivation: null, createdAt: "2026-09-27T00:00:00Z" },
  ],
  suggested: {
    weekly: "430.00",
    derivation: {
      takeHomeMonthly: "4333.33",
      committedMonthly: "1815.99",
      debtMinimumsMonthly: "395.00",
      extraMonthly: "250.00",
      goalsMonthly: "0.00",
      discretionaryMonthly: "1872.34",
    },
  },
} as AllowancePlans;

const item = (id: string, name: string, amount: string) => ({
  id, name, kind: "bill", amount, frequency: "monthly", active: "true", amountKind: "fixed",
});
const BILLS = {
  income: [],
  bills: [
    { item: item("b1", "Electric", "142.18"), nextOccurrence: "2026-10-08", monthlyAmount: "142.18", actualAmount: "0.00" },
    { item: item("b2", "Internet", "70.00"), nextOccurrence: "2026-10-12", monthlyAmount: "70.00", actualAmount: "0.00" },
    { item: item("b3", "Phone", "95.00"), nextOccurrence: "2026-10-15", monthlyAmount: "95.00", actualAmount: "0.00" },
  ],
  debtMins: [],
  monthly: {},
} as unknown as BillsSummary;

const row = (id: string, on: string, description: string, amount: string, categoryId: string | null, pending = false) => ({
  id, occurredOn: on, description, displayName: description, amount, categoryId, pending, countsInBalance: true,
});
const LEDGER = {
  rows: [
    row("t1", "2026-10-07", "Corner Market", "-18.40", "c1", true),
    row("t2", "2026-10-07", "Coffee Cart", "-6.25", null),
    row("t3", "2026-10-06", "Gas Station", "-41.10", "c2"),
    row("t4", "2026-10-06", "Pharmacy", "-12.99", "c1"),
  ],
  nextCursor: null,
  limit: 8,
  matchingCount: 4,
} as unknown as LedgerPage;

const CATEGORIES = [
  { id: "c1", name: "Groceries" },
  { id: "c2", name: "Fuel" },
] as Category[];

const loaded = <T,>(data: T): Read<T> => ({ data, state: "loaded", isFetching: false, refetch: () => {} });

const SAMPLE: TodayData = {
  spine: {
    data: SPINE,
    isLoading: false,
    isFetching: false,
    state: "loaded",
    error: null,
    updatedAt: "2026-10-07T14:59:00Z",
    refetch: () => {},
  },
  position: loaded(POSITION),
  plans: loaded(PLANS),
  settings: loaded({ weeklyAllowanceAmount: "250.00", monthlyAllowanceAmount: "0", unplannedAllowanceAmount: "0" } as Settings),
  bills: loaded(BILLS),
  ledger: loaded(LEDGER),
  categories: loaded(CATEGORIES),
  trail: loaded({
    actions: [
      { id: "a1", runId: "r1", type: "set_category", targetKind: "transaction", targetId: "t1", outcome: "applied", reversible: true, undoneAt: null, createdAt: "2026-10-07T14:10:00Z" },
      { id: "a2", runId: "r1", type: "set_category", targetKind: "transaction", targetId: "t3", outcome: "applied", reversible: true, undoneAt: null, createdAt: "2026-10-07T14:10:00Z" },
      { id: "a3", runId: "r2", type: "finding", targetKind: "finding", targetId: "f1", outcome: "needs_attention", reversible: false, undoneAt: null, createdAt: "2026-10-06T22:00:00Z" },
    ],
  } as AgentActionList),
  unfiled: loaded({ rows: [], nextCursor: null, limit: 1, matchingCount: 2 } as unknown as LedgerPage),
};

export default function DesignToday() {
  return (
    <div className="flex flex-col gap-6" data-testid="page-design-today">
      <Note kind="empty" data-testid="sample-note">
        Sample — every figure on this page is made up.
      </Note>
      <TodayView data={SAMPLE} now={NOW} live={false} />
    </div>
  );
}
