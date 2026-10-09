import { cn } from "@/lib/utils";
import { Panel } from "@/components/next";
import { FindingsList } from "@/components/agent/FindingsList";
import { useOpenFindings } from "@/components/agent/agentHooks";
import { ATTENTION } from "./belowFoldSizes";
import { rise } from "./shared";

/**
 * (F3) "Needs attention": the proactive monitor's open findings. Nothing open,
 * or a monitor that has not answered, draws no panel at all: a finding that is
 * not there is not a zero, and the panel sits last so its arrival moves
 * nothing above it. It lives in the lazy below-the-fold chunk.
 *
 * `duplicate_charge` overlaps the "Possible duplicates" row in Needs review and
 * Settings' duplicate merge; `shortfall_before_income` overlaps the forecast.
 * They are different sources (the monitor's detectors) and are left as is.
 */
export default function AttentionPanel() {
  const q = useOpenFindings();
  const findings = q.data?.findings ?? [];
  if (findings.length === 0) return null;
  return (
    <Panel
      title="Needs attention"
      sub="What H2 noticed on its own"
      span={ATTENTION.span}
      variant="static"
      className={cn(rise(ATTENTION.rise))}
      data-testid="dash-attention"
    >
      <FindingsList findings={findings} />
    </Panel>
  );
}
