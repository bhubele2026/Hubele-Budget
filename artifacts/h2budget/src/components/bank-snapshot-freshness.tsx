import { formatRelativeTime } from "@/lib/utils";

// Tiny "Last auto-updated 12 minutes ago" / "Set manually 3 hours ago"
// label shared by the Forecast, Dashboard, and Transactions pages so
// users see the same freshness signal everywhere the bank snapshot is
// surfaced (Tasks #285, #333). Lives here as a standalone component so
// the page-level tests can render it without spinning up the full pages
// and their many query hooks.
export function BankSnapshotFreshness({
  source,
  at,
  now,
}: {
  source: "manual" | "plaid";
  at: string;
  now?: Date;
}) {
  const prefix = source === "plaid" ? "Last auto-updated " : "Set manually ";
  return (
    <div data-testid="text-bank-snapshot-freshness">
      {prefix}
      {formatRelativeTime(at, now)}
    </div>
  );
}
