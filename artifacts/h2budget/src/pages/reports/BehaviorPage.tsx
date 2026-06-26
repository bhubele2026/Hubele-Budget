import { useState } from "react";
import {
  useReportsData,
  AdvisorSummaryCard,
  ReportShell,
  ReportsRangeControls,
  daysForMode,
} from "./reportsShared";
import { type RangeMode } from "@/lib/timeRange";
import { BehaviorSection } from "./BehaviorSection";
import { SubscriptionInsightsSection } from "@/components/subscription-insights";
import { fmtISO } from "@/lib/reportsAnalytics";

export default function BehaviorPage() {
  // Weekly-first: opens on the current week; Mo/Yr are opt-in.
  const [mode, setMode] = useState<RangeMode>("wk");
  const rangeDays = daysForMode(mode);
  const d = useReportsData(rangeDays, 0);
  if (d.txnsLoading) return null;
  return (
    <ReportShell
      crumb="Behavior & Fun"
      title="Behavior & Fun"
      blurb="The patterns behind the spending — when, how often, and the odd surprise."
    >
      <ReportsRangeControls mode={mode} setMode={setMode} showCompare={false} />
      <AdvisorSummaryCard tab="behavior" rangeDays={rangeDays} monthOffset={0} />
      <BehaviorSection from={fmtISO(d.fromDate)} to={fmtISO(d.today)} />
      <SubscriptionInsightsSection
        recurringItems={d.recurringItems}
        txns={d.txns}
        catNameById={d.catNameById}
      />
    </ReportShell>
  );
}
