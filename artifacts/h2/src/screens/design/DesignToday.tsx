import { lazy, Suspense, useState } from "react";
import { useSearch } from "wouter";
import type {
  AffordResult,
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
import { importAfford } from "@/lib/routePrefetch";
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

const AffordSheet = lazy(importAfford);

// The Afford sheet's open state on made-up figures: `?afford=fits|tight|dip|overdraw|later`
// (any other value is "tight"). The worked $300-on-Saturday example from the PR-F1 note.
const fig = (safe: string, week: string, payday: string, lowest: string) => ({
  safeToSpendNow: safe, remainingWeek: week, availableUntilPayday: payday, lowest, lowestDate: "2026-10-13",
  debtFreeEarliest: "2027-03", debtFreeLatest: "2027-06", totalInterestLow: "1800.00",
});
function affordSample(kind: string): AffordResult {
  const base = {
    amount: "300.00", dateISO: "2026-10-10",
    baseline: fig("144.50", "144.50", "2124.50", "2624.50"),
    proposed: fig("0.00", "-155.50", "2124.50", "2324.50"),
    delta: { safeToSpendNow: "-144.50", remainingWeek: "-300.00", availableUntilPayday: "0.00", lowest: "-300.00", lowestDate: "2026-10-13", debtFreeEarliest: 0, debtFreeLatest: 0, totalInterestLow: "0.00" },
    category: { categoryId: "c1", remainingBefore: "274.50", remainingAfter: "-25.50" },
    debt: { affected: false, cut: "0.00", cutMonth: null, debtFreeMonthShift: 0, interestDelta: "0.00" },
    verdict: "tight",
    assumptions: ["Bank data from Oct 7.", "The purchase counts against this week's limit.", "Available credit is not counted."],
  };
  if (kind === "fits") return { ...base, amount: "40.00", proposed: fig("104.50", "104.50", "2084.50", "2584.50"), category: { categoryId: "c1", remainingBefore: "274.50", remainingAfter: "234.50" }, verdict: "fits" } as AffordResult;
  if (kind === "dip") return { ...base, proposed: fig("0.00", "-155.50", "1824.50", "400.00"), verdict: "breaks_buffer" } as AffordResult;
  if (kind === "overdraw") return { ...base, amount: "2800.00", proposed: fig("0.00", "-2655.50", "-675.50", "-175.50"), verdict: "breaks_zero" } as AffordResult;
  if (kind === "later") {
    return {
      ...base,
      proposed: { ...fig("0.00", "-155.50", "1824.50", "2324.50"), debtFreeEarliest: "2027-04", debtFreeLatest: "2027-07", totalInterestLow: "1830.00" },
      debt: { affected: true, cut: "300.00", cutMonth: "2026-10", debtFreeMonthShift: 1, interestDelta: "30.00" },
    } as AffordResult;
  }
  return base as AffordResult;
}

export default function DesignToday() {
  const kind = new URLSearchParams(useSearch()).get("afford");
  const [open, setOpen] = useState(kind != null);
  return (
    <div className="flex flex-col gap-6" data-testid="page-design-today">
      <Note kind="empty" data-testid="sample-note">
        Sample — every figure on this page is made up.
      </Note>
      <TodayView data={SAMPLE} now={NOW} live={false} />
      {kind != null && (
        <Suspense fallback={null}>
        <AffordSheet
          open={open}
          onOpenChange={setOpen}
          now={NOW}
          sample={{ amount: affordSample(kind).amount, date: affordSample(kind).dateISO, categoryId: "c1", categoryName: "Dining", result: affordSample(kind) }}
        />
        </Suspense>
      )}
    </div>
  );
}
