import { useState } from "react";
import {
  useReportsData,
  AdvisorSummaryCard,
  ReportShell,
  ReportsRangeControls,
} from "./reportsShared";
import { CashFlowSection } from "./CashFlowSection";

export default function CashFlowPage() {
  const [rangeDays, setRangeDays] = useState("30");
  const [compareToPrev, setCompareToPrev] = useState(false);
  const d = useReportsData(Number(rangeDays), 0);
  if (d.txnsLoading) return null;
  return (
    <ReportShell
      crumb="Cash Flow"
      title="Cash Flow"
      blurb="What came in, what went out, and the shape of the gap between them."
    >
      <ReportsRangeControls
        rangeDays={rangeDays}
        setRangeDays={setRangeDays}
        compareToPrev={compareToPrev}
        setCompareToPrev={setCompareToPrev}
      />
      <AdvisorSummaryCard tab="cashflow" rangeDays={Number(rangeDays)} monthOffset={0} />
      <CashFlowSection
        txns={d.rangeTxns}
        prevTxns={d.prevRangeTxns}
        rangeDays={Number(rangeDays)}
        compareToPrev={compareToPrev}
        catNameById={d.catNameById}
        excludedCategoryIds={d.excludedCategoryIds}
        recurringItems={d.recurringItems ?? []}
        forecast={d.forecast ?? null}
      />
    </ReportShell>
  );
}
