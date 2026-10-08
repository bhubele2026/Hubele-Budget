import { Link, useSearch } from "wouter";
import type {
  AllowancePlans,
  AvalancheExtra,
  AvalancheSettings,
  BillsSummary,
  BudgetMonthDetail,
  Category,
  Debt,
  DebtPlan,
  MeResponse,
  Member,
  MoneyPosition,
  RecurringItem,
  Spine,
} from "@workspace/api-client-react";
import type { Read } from "@/data/todayData";
import type { BillsData, CategoriesData, DebtData, WeekData } from "@/screens/plan/planData";
import { Note } from "@/kit/Note";
import { BillsView } from "@/screens/plan/PlanBills";
import { CategoriesView } from "@/screens/plan/PlanCategories";
import { DebtView } from "@/screens/plan/PlanDebt";
import { WeekView } from "@/screens/plan/PlanWeek";
import PlanWishlist from "@/screens/plan/PlanWishlist";

/**
 * ⭐ /design/plan — PLAN ON MADE-UP DATA, for judging the composition without
 * signing in. Public, lazy, no network on load: every figure is invented, fixed
 * to one day, and the page says "sample" at the top. `?page=` picks the screen
 * (week, bills, debt, categories, wishlist). Saving from a sample page reaches
 * for the API like the real page does, so it answers with an error here.
 */
const NOW = new Date("2026-10-07T15:00:00Z"); // Wednesday, 10:00 in Chicago
const MONTH = "2026-10-01";

const loaded = <T,>(data: T): Read<T> => ({ data, state: "loaded", isFetching: false, refetch: () => {} });

const SPINE = {
  asOf: "2026-10-07T14:59:00Z",
  bank: { balance: "12345.67", asOfDate: "2026-10-07T14:48:00Z", source: "plaid", lastContactAt: "2026-10-07T14:48:00Z", lastFailureAt: null, stale: false, staleReason: null },
  spentMonth: 1890.12,
  spentWeek: 305.5,
  nextBill: null,
  billsDueCount: 3,
  forecast: { lowPoint: "800.00", lowPointDate: "2026-10-20", runwayDays: null, cashBuffer: "500.00", status: "ready" },
  debt: { payoffPct: 41.3 },
  reviewCount: 0,
  position: { safeToSpendNow: "144.50", remainingWeek: "44.50", availableUntilPayday: "2124.50", paydayDate: "2026-10-09", horizonKind: "payday", withinPlan: "tight", confidence: "firm", degraded: false },
} as unknown as Spine;
const spineRead = { data: SPINE, isLoading: false, isFetching: false, state: "loaded" as const, error: null, updatedAt: "2026-10-07T14:59:00Z", refetch: () => {} };

const PLANS = {
  plans: [
    { id: "p1", memberUserId: null, period: "weekly", amount: "350.00", effectiveFrom: "2026-09-27", source: "owner", derivation: null, createdAt: "2026-09-27T00:00:00Z" },
    { id: "p2", memberUserId: "u2", period: "weekly", amount: "60.00", effectiveFrom: "2026-09-27", source: "owner", derivation: null, createdAt: "2026-09-27T00:00:00Z" },
  ],
  suggested: {
    weekly: "430.00",
    derivation: { takeHomeMonthly: "4333.33", committedMonthly: "1815.99", debtMinimumsMonthly: "395.00", extraMonthly: "250.00", goalsMonthly: "0.00", discretionaryMonthly: "1872.34" },
  },
} as unknown as AllowancePlans;
const POSITION = { weekCap: "350.00", spentWeekDiscretionary: "305.50", remainingWeek: "44.50", withinPlan: "tight" } as unknown as MoneyPosition;
const ME = { userId: "u1", isOwner: true, displayName: "Sam (sample)" } as MeResponse;
const MEMBERS = [
  { id: "u1", displayName: "Sam (sample)", isOwner: true },
  { id: "u2", displayName: "Alex (sample)", isOwner: false },
] as Member[];

const item = (id: string, name: string, kind: string, amount: string, frequency: string, extra: Partial<RecurringItem> = {}) =>
  ({ id, name, kind, amount, frequency, active: "true", amountKind: "fixed", ...extra }) as RecurringItem;
const ITEMS = [
  item("i1", "Paycheck", "income", "2000.00", "biweekly", { anchorDate: "2026-10-09" }),
  item("i2", "Rent", "bill", "1450.00", "monthly", { dayOfMonth: 1, categoryId: "c1" }),
  item("i3", "Electric", "bill", "142.18", "monthly", { dayOfMonth: 12, amountKind: "estimate", categoryId: "c2" }),
  item("i4", "Streaming", "subscription", "15.99", "monthly", { dayOfMonth: 20 }),
  item("i5", "Car registration", "bill", "89.00", "onetime", { anchorDate: "2026-10-30" }),
  item("i6", "Weekly Spend", "bill", "350.00", "weekly"),
  item("i7", "Monthly Spend", "bill", "120.00", "monthly"),
];
const row = (i: RecurringItem, next: string | null) => ({ item: i, nextOccurrence: next, monthlyAmount: i.amount, actualAmount: "0.00" });
const SUMMARY = {
  income: [row(ITEMS[0]!, "2026-10-09")],
  bills: [row(ITEMS[1]!, "2026-11-01"), row(ITEMS[2]!, "2026-10-12"), row(ITEMS[3]!, "2026-10-20"), row(ITEMS[4]!, "2026-10-30")],
  debtMins: [],
  monthly: {},
} as unknown as BillsSummary;
const CATEGORIES = [
  { id: "c1", name: "Housing", kind: "expense", groupName: "Home", sourceKind: "auto_bills", sortOrder: 1 },
  { id: "c2", name: "Utilities", kind: "expense", groupName: "Home", sourceKind: "manual", sortOrder: 2 },
  { id: "c3", name: "Pay", kind: "income", groupName: "Income", sourceKind: "manual", sortOrder: 3 },
] as Category[];

const debt = (id: string, name: string, apr: string, min: string, over: Partial<Debt> = {}) =>
  ({ id, name, balance: "4200.00", apr, minPayment: min, payment: min, status: "active", sortOrder: 1, dueDay: 12, balanceSource: "plaid", aprSource: "plaid", minPaymentSource: "manual", ...over }) as Debt;
const DEBTS = [debt("d1", "Sample Card A", "0.2499", "95.00"), debt("d2", "Sample Card B", "0.1899", "60.00", { dueDay: 21, aprSource: "manual", balanceSource: "manual" })];
const PLAN = {
  asOf: "2026-10-07",
  strategy: "avalanche",
  extraMonthly: 250,
  comparison: {
    avalanche: { monthsToFreedom: 29, debtFreeMonth: "2029-03", totalInterest: 3480, firstKill: { debtId: "d2", month: "2027-01" } },
    snowball: { monthsToFreedom: 30, debtFreeMonth: "2029-04", totalInterest: 3720, firstKill: { debtId: "d2", month: "2027-01" } },
    delta: { months: 1, interest: 240 },
    killMonths: [],
    detail: { debts: [] },
  },
  range: {
    earliestMonth: "2029-03",
    latestMonth: "2029-11",
    interestLow: 3480,
    interestHigh: 4650,
    newChargesPerMonth: 0,
    runs: [],
    assumptions: [
      { key: "a1", text: "Payments continue at today's minimums plus your extra." },
      { key: "a2", text: "No new charges are added, except the measured run in the high end." },
    ],
  },
  milestones: {
    achieved: [{ key: "m1", label: "First card at zero", debtId: null, achievedOn: "2026-08-14" }],
    next: { key: "m2", label: "Half paid", estimatedMonth: "2027-06" },
    upcoming: [],
  },
  planned60d: [
    { date: "2026-10-12", itemId: "x1", debtId: "d1", label: "Sample Card A minimum", amount: 95 },
    { date: "2026-10-21", itemId: "x2", debtId: "d2", label: "Sample Card B minimum", amount: 60 },
  ],
  confirmedMtd: 155,
  paidDownGenuineMtd: 155,
  assumptions: [],
} as unknown as DebtPlan;
const SETTINGS = { strategy: "avalanche", extraSource: "manual", manualExtra: "250.00", budgetMode: "budgeted" } as AvalancheSettings;
const EXTRA = { source: "manual", amount: "250.00", monthStart: MONTH, availableMoney: "420.00" } as AvalancheExtra;

const line = (id: string, name: string, planned: string, posted: string, pending: string, over: Record<string, unknown> = {}) =>
  ({
    id, categoryId: id, categoryName: name, plannedAmount: planned, actualAmount: (Number(posted) + Number(pending)).toFixed(2),
    postedAmount: posted, pendingAmount: pending, combinedAmount: (Number(posted) + Number(pending)).toFixed(2),
    groupName: "Home", sourceKind: "manual", planSource: "unbacked", sortOrder: 1, kind: "expense", pinned: false,
    plannedSource: { kind: "manual", bills: [] }, ...over,
  }) as unknown as BudgetMonthDetail["lines"][number];
const L1 = line("c1", "Housing", "1450.00", "1450.00", "0.00", { sourceKind: "auto_bills", planSource: "bills", plannedSource: { kind: "bills", bills: [{ id: "i2", name: "Rent", amount: "1450.00", frequency: "monthly", eventCount: 1 }] } });
const L2 = line("c2", "Utilities", "260.00", "142.18", "30.00");
const L3 = line("c4", "Groceries", "400.00", "212.40", "18.40", { groupName: "Everyday" });
const MONTH_DETAIL = {
  monthStart: MONTH,
  monthPinned: false,
  lines: [L1, L2, L3],
  groups: [
    { groupName: "Home", plannedTotal: "1710.00", actualTotal: "1622.18", lines: [L1, L2] },
    { groupName: "Everyday", plannedTotal: "400.00", actualTotal: "230.80", lines: [L3] },
  ],
  summary: { expenses: { budget: "2110.00", actual: "1852.98" }, income: { budget: "4333.00", actual: "2000.00" }, net: { budget: "2223.00", actual: "147.02" }, percentSpent: { budget: "0", actual: "0" } },
  replacedPendingIds: [],
  inheritedCategories: [],
} as unknown as BudgetMonthDetail;

const WEEK: WeekData = { spine: spineRead, plans: loaded(PLANS), position: loaded(POSITION), me: loaded(ME), members: loaded(MEMBERS) };
const BILLS: BillsData = { items: loaded(ITEMS), summary: loaded(SUMMARY), categories: loaded(CATEGORIES) };
const DEBT: DebtData = { spine: spineRead, plan: loaded(PLAN), settings: loaded(SETTINGS), extra: loaded(EXTRA), debts: loaded(DEBTS) };
const CATS: CategoriesData = { month: loaded(MONTH_DETAIL) };

const PAGES = ["week", "bills", "debt", "categories", "wishlist"] as const;

export default function DesignPlan() {
  const search = useSearch();
  const page = new URLSearchParams(search).get("page") ?? "week";
  return (
    <div className="flex flex-col gap-6" data-testid="page-design-plan">
      <Note kind="empty" data-testid="sample-note">
        Sample — every figure on this page is made up.
      </Note>
      <p className="flex flex-wrap gap-4 type-label" data-testid="sample-pages">
        {PAGES.map((p) => (
          <Link key={p} href={`/design/plan?page=${p}`} className={p === page ? "text-ink" : "text-moss underline decoration-1 underline-offset-4"}>
            {p}
          </Link>
        ))}
      </p>
      {page === "bills" ? (
        <BillsView data={BILLS} />
      ) : page === "debt" ? (
        <DebtView data={DEBT} now={NOW} />
      ) : page === "categories" ? (
        <CategoriesView data={CATS} monthStart={MONTH} onMonth={() => {}} now={NOW} />
      ) : page === "wishlist" ? (
        <PlanWishlist />
      ) : (
        <WeekView data={WEEK} now={NOW} />
      )}
    </div>
  );
}
