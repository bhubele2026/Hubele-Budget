import { Sparkles } from "lucide-react";
import { useGetAdvisorNudge } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";

/**
 * The savage AI coach's one-liner, as a slim bar to drop at the top of any
 * page. Reads the same cached nudge as the Command Center; hides itself when
 * the model has nothing worth saying.
 */
export function AiInsightBar({ className }: { className?: string }) {
  const { data: nudge } = useGetAdvisorNudge();
  if (!nudge?.enabled || !nudge.message) return null;

  const color =
    nudge.severity === "alert"
      ? "text-[hsl(var(--negative))]"
      : nudge.severity === "warn"
        ? "text-amber-500"
        : "text-foreground";

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border border-border bg-card px-4 py-2.5",
        className,
      )}
      data-testid="ai-insight-bar"
    >
      <Sparkles className="w-4 h-4 mt-0.5 text-primary shrink-0" />
      <p className={cn("text-sm font-medium leading-snug", color)}>
        {nudge.message}
      </p>
    </div>
  );
}
