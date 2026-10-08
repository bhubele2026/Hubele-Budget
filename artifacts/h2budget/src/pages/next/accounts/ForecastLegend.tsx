import { cn } from "@/lib/utils";
import type { AccountIdentity } from "@/lib/accountIdentity";

const DOT: Record<AccountIdentity["accent"], string> = {
  checking: "bg-acct-checking", amex: "bg-acct-amex", card2: "bg-acct-card2", other: "bg-acct-other",
};

/** The three markers the forecast draws for a card, in the same accents. */
export function ForecastLegend({ card }: { card: AccountIdentity }) {
  const items: Array<{ key: string; word: string; accent: AccountIdentity["accent"] }> = [
    { key: "charged", word: "Charged to this card", accent: card.accent },
    { key: "paid", word: "Paid from checking", accent: "checking" },
    { key: "payment", word: "Payment to this card", accent: card.accent },
  ];
  return (
    <ul aria-label="Forecast legend" data-testid="forecast-legend" className="flex flex-wrap gap-x-4 gap-y-1 text-micro text-neutral-600">
      {items.map((i) => (
        <li key={i.key} data-testid={`legend-${i.key}`} data-accent={i.accent} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={cn("inline-block h-2.5 w-2.5 rounded-full", DOT[i.accent], i.key === "payment" && "ring-2 ring-white outline outline-1 outline-brand-line")} />
          {i.word}
        </li>
      ))}
    </ul>
  );
}
