import { useState } from "react";
import {
  useReportsData,
  ReportShell,
  ReportsRangeControls,
  daysForMode,
} from "./reportsShared";
import { PageSkeleton } from "@/components/page-skeleton";
import { type RangeMode } from "@/lib/timeRange";
import { BehaviorSection } from "./BehaviorSection";
import { fmtISO } from "@/lib/reportsAnalytics";

export default function BehaviorPage() {
  // Weekly-first: opens on the current week; Mo/Yr are opt-in.
  const [mode, setMode] = useState<RangeMode>("wk");
  const rangeDays = daysForMode(mode);
  const d = useReportsData(rangeDays, 0);
  if (d.txnsLoading) return <PageSkeleton />;
  return (
    <ReportShell
      crumb="Behavior & Fun"
      title="Behavior & Fun"
      blurb="The patterns behind the spending — when, how often, and the odd surprise."
    >
      <ReportsRangeControls mode={mode} setMode={setMode} showCompare={false} />
      <BehaviorSection from={fmtISO(d.fromDate)} to={fmtISO(d.today)} />
    </ReportShell>
  );
}
