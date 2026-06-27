import { Sparkles } from "lucide-react";
import { useGetAdvisorNudge } from "@workspace/api-client-react";
import { useCoachIntensity } from "@/hooks/useCoachIntensity";
import { cn } from "@/lib/utils";

// Client-side softener: when the coach is set to "cheeky", swap the spicier
// words for tamer ones so the line reads playful, not profane. The server text
// is untouched (no backend change) — this is purely a display transform gated
// on the local preference. Savage shows the line verbatim.
const SOFTEN: [RegExp, string][] = [
  [/\bbloody\b/gi, "blooming"],
  [/\bdamn(ed)?\b/gi, "darn"],
  [/\bhell\b/gi, "heck"],
  [/\bcrap\b/gi, "rubbish"],
  [/\bpiss(ed)?\b/gi, "miffed"],
  [/\barse\b/gi, "backside"],
  [/\bwanker(s)?\b/gi, "wally"],
  [/\bskint\b/gi, "broke"],
];
function soften(text: string): string {
  return SOFTEN.reduce((s, [re, to]) => s.replace(re, to), text);
}

/**
 * The savage AI coach's one-liner, as a slim bar to drop at the top of any
 * page. Reads the same cached nudge as the Command Center; hides itself when
 * the model has nothing worth saying.
 */
export function AiInsightBar({ className }: { className?: string }) {
  const { data: nudge } = useGetAdvisorNudge();
  const [intensity] = useCoachIntensity();
  if (!nudge?.enabled || !nudge.message) return null;

  const message =
    intensity === "cheeky" ? soften(nudge.message) : nudge.message;

  const color =
    nudge.severity === "alert"
      ? "text-[hsl(var(--negative))]"
      : nudge.severity === "warn"
        ? "text-warning"
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
        {message}
      </p>
    </div>
  );
}
