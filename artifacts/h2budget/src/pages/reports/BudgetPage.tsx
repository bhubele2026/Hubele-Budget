import { useState } from "react";
import { useReportsData, AdvisorSummaryCard, ReportShell } from "./reportsShared";
import { BudgetSection } from "./BudgetSection";

export default function BudgetPage() {
  const [monthOffset, setMonthOffset] = useState("0");
  const d = useReportsData(30, Number(monthOffset));
  if (d.txnsLoading) return null;
  return (
    <ReportShell
      crumb="Budget"
      title="Budget"
      blurb="Planned vs actual, bucket by bucket, for the month you pick."
    >
      <AdvisorSummaryCard tab="budget" rangeDays={30} monthOffset={Number(monthOffset)} />
      <BudgetSection
        monthStart={d.budgetMonthStart}
        monthOffset={monthOffset}
        setMonthOffset={setMonthOffset}
      />
    </ReportShell>
  );
}
