import { useState } from "react";
import {
  useReportsData,
  ReportShell,
  ReportsRangeControls,
  daysForMode,
} from "./reportsShared";
import { PageSkeleton } from "@/components/page-skeleton";
import { type RangeMode } from "@/lib/timeRange";
import { CashFlowSection } from "./CashFlowSection";

export default function CashFlowPage() {
  // Weekly-first: opens on the current week; Mo/Yr are opt-in.
  const [mode, setMode] = useState<RangeMode>("wk");
  const [compareToPrev, setCompareToPrev] = useState(false);
  const rangeDays = daysForMode(mode);
  const d = useReportsData(rangeDays, 0);
  if (d.txnsLoading) return <PageSkeleton />;
  return (
    <ReportShell
      crumb="Cash Flow"
      title="Cash Flow"
      blurb="What came in, what went out, and the shape of the gap between them."
    >
      <ReportsRangeControls
        mode={mode}
        setMode={setMode}
        compareToPrev={compareToPrev}
        setCompareToPrev={setCompareToPrev}
      />
      <CashFlowSection
        txns={d.rangeTxns}
        prevTxns={d.prevRangeTxns}
        rangeDays={rangeDays}
        compareToPrev={compareToPrev}
        catNameById={d.catNameById}
        excludedCategoryIds={d.excludedCategoryIds}
        recurringItems={d.recurringItems ?? []}
        forecast={d.forecast ?? null}
      />
    </ReportShell>
  );
}
