import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useGetForecastCashSignal } from "@workspace/api-client-react";
import { CheckCircle2, AlertTriangle, XCircle, HelpCircle } from "lucide-react";

const STATUS_META = {
  ready: {
    label: "Avalanche Ready",
    sub: "Safe to pay extra this month",
    Icon: CheckCircle2,
    accent: "text-positive",
    border: "border-positive/40",
  },
  tight: {
    label: "Tight",
    sub: "On the edge — extra payment is risky",
    Icon: AlertTriangle,
    accent: "text-warning",
    border: "border-warning/40",
  },
  not_yet: {
    label: "Not Yet",
    sub: "Projection dips below buffer — hold off",
    Icon: XCircle,
    accent: "text-destructive",
    border: "border-destructive/50",
  },
  no_data: {
    label: "No Bank Snapshot",
    sub: "Set a checking balance on Forecast to enable",
    Icon: HelpCircle,
    accent: "text-muted-foreground",
    border: "border-muted",
  },
} as const;

export function AvalancheReadyCard({ compact = false }: { compact?: boolean }) {
  const { data, isLoading } = useGetForecastCashSignal();

  if (isLoading || !data) {
    return (
      <Card>
        <CardContent className="p-5 space-y-3">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-3 w-48" />
        </CardContent>
      </Card>
    );
  }

  const meta = STATUS_META[data.status];
  const Icon = meta.Icon;
  const headroom = Number(data.maxSafeExtra) || 0;
  const lowest = Number(data.lowestProjected) || 0;
  const buffer = Number(data.cashBuffer) || 0;

  return (
    <Link
      href="/forecast"
      data-testid="link-avalanche-ready"
      className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
    >
      <Card className={`border-2 ${meta.border} cursor-pointer transition-shadow hover:shadow-md`}>
        <CardContent className={compact ? "p-4 space-y-2" : "p-5 space-y-3"}>
          <div className="flex items-center gap-2">
            <Icon className={`w-5 h-5 ${meta.accent}`} />
            <span className={`text-xs font-bold tracking-widest uppercase ${meta.accent}`}>
              {meta.label}
            </span>
          </div>
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-widest">
              Max safe extra payment
            </div>
            <div className={`text-3xl font-serif font-bold tabular-nums ${meta.accent}`}>
              {data.status === "no_data" ? "—" : formatCurrency(headroom)}
            </div>
          </div>
          <div className="text-xs text-muted-foreground">
            {data.status === "no_data" ? (
              meta.sub
            ) : (
              <>
                Lowest projected: <span className="tabular-nums">{formatCurrency(lowest)}</span>
                {data.lowestDate && <> on {formatDate(data.lowestDate)}</>} · buffer{" "}
                {formatCurrency(buffer)}
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
