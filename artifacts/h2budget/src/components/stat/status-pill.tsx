import { PillBadge } from "@/components/pill-badge";
import { type Status } from "@/lib/statusThresholds";

const TONE: Record<Status, "good" | "danger" | "warning" | "neutral"> = {
  good: "good",
  warning: "warning",
  danger: "danger",
  neutral: "neutral",
};

/**
 * Status pill for a stat card's top-right (UNDER / OVER / ON TRACK /
 * PROJECTED). Thin wrapper over PillBadge keyed by Status, so the whole kit
 * speaks one status vocabulary.
 */
export function StatusPill({
  status,
  children,
  className,
}: {
  status: Status;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <PillBadge tone={TONE[status]} className={className}>
      {children}
    </PillBadge>
  );
}
