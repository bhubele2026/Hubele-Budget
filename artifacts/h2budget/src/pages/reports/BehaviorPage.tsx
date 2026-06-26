import { useState } from "react";
import {
  useReportsData,
  AdvisorSummaryCard,
  ReportShell,
  ReportsRangeControls,
} from "./reportsShared";
import { BehaviorSection } from "./BehaviorSection";
import { SubscriptionInsightsSection } from "@/components/subscription-insights";
import { fmtISO } from "@/lib/reportsAnalytics";

export default function BehaviorPage() {
  const [rangeDays, setRangeDays] = useState("30");
  const d = useReportsData(Number(rangeDays), 0);
  if (d.txnsLoading) return null;
  return (
    <ReportShell
      crumb="Behavior & Fun"
      title="Behavior & Fun"
      blurb="The patterns behind the spending — when, how often, and the odd surprise."
    >
      <ReportsRangeControls
        rangeDays={rangeDays}
        setRangeDays={setRangeDays}
        showCompare={false}
      />
      <AdvisorSummaryCard tab="behavior" rangeDays={Number(rangeDays)} monthOffset={0} />
      <BehaviorSection from={fmtISO(d.fromDate)} to={fmtISO(d.today)} />
      <SubscriptionInsightsSection
        recurringItems={d.recurringItems}
        txns={d.txns}
        catNameById={d.catNameById}
      />
    </ReportShell>
  );
}
