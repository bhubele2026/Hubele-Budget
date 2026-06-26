import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useCoachIntensity, type CoachIntensity } from "@/hooks/useCoachIntensity";
import { cn } from "@/lib/utils";

const OPTIONS: { value: CoachIntensity; label: string; blurb: string }[] = [
  { value: "cheeky", label: "Cheeky", blurb: "Playful nudges. Light ribbing, no profanity." },
  { value: "savage", label: "Savage", blurb: "Full British tough-love. Blunt, funny, swears." },
];

/**
 * Settings card for the coach voice intensity (client-only preference). The
 * server advisor voice is unchanged; this dials the FRONTEND sassy copy +
 * gates profanity so Hannah has an escape hatch. Default Savage.
 */
export function CoachVoiceCard() {
  const [intensity, setIntensity] = useCoachIntensity();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Coach voice</CardTitle>
        <CardDescription>
          How hard the in-app money coach roasts you. The numbers never change —
          only the mouth on it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3">
          {OPTIONS.map((o) => {
            const active = intensity === o.value;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => setIntensity(o.value)}
                aria-pressed={active}
                data-testid={`coach-intensity-${o.value}`}
                className={cn(
                  "rounded-2xl border p-4 text-left transition-colors",
                  active
                    ? "border-primary ring-1 ring-primary/30 bg-primary/[0.04]"
                    : "border-card-border hover:border-primary/40",
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{o.label}</span>
                  {active && (
                    <span className="text-[10px] font-bold uppercase tracking-wider text-primary">
                      Active
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{o.blurb}</p>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
