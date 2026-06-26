import { useState } from "react";
import {
  useReportsData,
  AdvisorSummaryCard,
  ReportShell,
  ReportsRangeControls,
} from "./reportsShared";
import { SpendingSection } from "./SpendingSection";
import { fmtISO } from "@/lib/reportsAnalytics";

export default function SpendingPage() {
  const [rangeDays, setRangeDays] = useState("30");
  const d = useReportsData(Number(rangeDays), 0);
  if (d.txnsLoading) return null;
  return (
    <ReportShell
      crumb="Spending"
      title="Spending"
      blurb="Where it all went — by category, by merchant, by day."
    >
      <ReportsRangeControls
        rangeDays={rangeDays}
        setRangeDays={setRangeDays}
        showCompare={false}
      />
      <AdvisorSummaryCard tab="spending" rangeDays={Number(rangeDays)} monthOffset={0} />
      <SpendingSection
        from={fmtISO(d.fromDate)}
        to={fmtISO(d.today)}
        txns={d.rangeTxns}
        categories={(d.categories ?? []).map((c) => ({ id: c.id, name: c.name }))}
      />
    </ReportShell>
  );
}
