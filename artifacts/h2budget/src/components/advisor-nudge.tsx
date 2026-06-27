import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Sparkles, AlertTriangle, AlertCircle, X } from "lucide-react";
import { useGetAdvisorNudge } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";

// localStorage key — once dismissed, hide for the rest of the day. The key
// includes today's ISO date so it auto-expires at midnight.
function dismissKey(): string {
  const d = new Date();
  return `advisor-nudge-dismissed-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
    2,
    "0",
  )}-${String(d.getDate()).padStart(2, "0")}`;
}

const SEVERITY_META = {
  info: {
    Icon: Sparkles,
    accent: "text-primary",
    bg: "bg-primary/10",
    border: "border-primary/30",
  },
  warn: {
    Icon: AlertTriangle,
    accent: "text-warning",
    bg: "bg-warning/10",
    border: "border-warning/30",
  },
  alert: {
    Icon: AlertCircle,
    accent: "text-destructive",
    bg: "bg-destructive/5",
    border: "border-destructive/30",
  },
} as const;

export function AdvisorNudge() {
  const { data, isLoading } = useGetAdvisorNudge();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const check = () => {
      setDismissed(window.localStorage.getItem(dismissKey()) === "1");
    };
    check();
    const id = window.setInterval(check, 60_000);
    return () => window.clearInterval(id);
  }, []);

  if (isLoading) return null;
  if (!data?.enabled) return null;
  if (!data.message) return null;
  if (data.source === "empty") return null;
  if (dismissed) return null;

  const severity = data.severity ?? "info";
  const meta = SEVERITY_META[severity];
  const Icon = meta.Icon;

  const handleDismiss = () => {
    window.localStorage.setItem(dismissKey(), "1");
    setDismissed(true);
  };

  return (
    <Card
      className={cn("border", meta.border, meta.bg)}
      data-testid="advisor-nudge"
    >
      <CardContent className="p-4 flex items-start gap-3">
        <Icon className={cn("w-5 h-5 mt-0.5 shrink-0", meta.accent)} />
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-widest font-semibold text-muted-foreground mb-1">
            Advisor
          </div>
          <p className="text-sm leading-relaxed">{data.message}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground"
          onClick={handleDismiss}
          aria-label="Dismiss"
          data-testid="advisor-nudge-dismiss"
        >
          <X className="w-4 h-4" />
        </Button>
      </CardContent>
    </Card>
  );
}
