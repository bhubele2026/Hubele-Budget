import { useReportsData, AdvisorSummaryCard, ReportShell } from "./reportsShared";
import { PageSkeleton } from "@/components/page-skeleton";
import { DebtSection } from "./DebtSection";

export default function DebtPage() {
  const d = useReportsData(30, 0);
  if (d.txnsLoading) return <PageSkeleton />;
  return (
    <ReportShell
      crumb="Debt Payoff"
      title="Debt Payoff"
      blurb="Momentum on the avalanche — what's falling, what's next, and when you're free."
    >
      <AdvisorSummaryCard tab="debt" rangeDays={30} monthOffset={0} />
      <DebtSection
        debts={d.debts ?? []}
        balanceHistory={d.debtBalanceHistory ?? []}
        strategy={(d.avSettings?.strategy as "avalanche" | "snowball") ?? "avalanche"}
        extraPerMonth={Number(d.avExtra?.amount ?? d.avSettings?.manualExtra ?? 0)}
        today={d.today}
      />
    </ReportShell>
  );
}
