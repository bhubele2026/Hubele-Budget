import { useState } from "react";
import {
  useReportsData,
  AdvisorSummaryCard,
  ReportShell,
  ReportsRangeControls,
  daysForMode,
} from "./reportsShared";
import { PageSkeleton } from "@/components/page-skeleton";
import { type RangeMode } from "@/lib/timeRange";
import { SpendingSection } from "./SpendingSection";
import { fmtISO } from "@/lib/reportsAnalytics";

export default function SpendingPage() {
  // Weekly-first: opens on the current week; Mo/Yr are opt-in.
  const [mode, setMode] = useState<RangeMode>("wk");
  const rangeDays = daysForMode(mode);
  const d = useReportsData(rangeDays, 0);
  if (d.txnsLoading) return <PageSkeleton />;
  return (
    <ReportShell
      crumb="Spending"
      title="Spending"
      blurb="Where it all went — by category, by merchant, by day."
    >
      <ReportsRangeControls mode={mode} setMode={setMode} showCompare={false} />
      <AdvisorSummaryCard tab="spending" rangeDays={rangeDays} monthOffset={0} />
      <SpendingSection
        from={fmtISO(d.fromDate)}
        to={fmtISO(d.today)}
        txns={d.rangeTxns}
        categories={(d.categories ?? []).map((c) => ({ id: c.id, name: c.name }))}
      />
    </ReportShell>
  );
}
