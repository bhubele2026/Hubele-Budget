import { useEffect } from "react";
import { Link } from "wouter";
import { useOwner } from "@/hooks/useOwner";
import { useCashSignalQ } from "./queries";
import { money } from "./shared";
import type { TileStatus } from "./tileParts";
import { planStatusWords } from "@/lib/planWords";

/**
 * (E3) The week tile with no plan. Reads the cash signal the header already asked for (same key, no new request):
 * the first weekly Spend occurrence says whether the forecast holds the item's own amount (the line, and for the
 * owner the one way to set a plan) or a plan that reads $0 (`onStatus`: the chip says "Plan set to $0" instead).
 * Its own lazy chunk: the landing is at its byte cap and none of this belongs to the first paint. The action sits
 * above the tile's stretched link (`relative z-10`). A member, or an unanswered `/me`, gets the line only.
 */
export default function WeekPlanAction({ onStatus }: { onStatus: (s: TileStatus) => void }) {
  const owner = useOwner();
  const cash = useCashSignalQ(90);
  const weekly = (cash.data?.hookReserves ?? []).filter((r) => r.hook === "weekly").sort((a, b) => (a.occurrenceDate < b.occurrenceDate ? -1 : 1))[0];
  const zero = weekly?.basis === "plan";
  useEffect(() => {
    if (zero) onStatus({ word: planStatusWords({ status: "not_set", source: "plan" }) ?? "", tone: "neutral" });
  }, [zero, onStatus]);
  if (zero) return null;
  const assumed = weekly?.basis === "stored_amount" ? money(weekly.storedAmount ?? weekly.amount).replace(/\.00$/, "") : null;
  return (
    <>
      {assumed ? <div className="text-label text-neutral-600" data-testid="tile-week-assumed">Forecast assumes {assumed} a week</div> : null}
      {owner === true && (cash.data !== undefined || cash.isError) ? (
        <Link href="/spending/week?plan=1" className="relative z-10 w-fit text-label font-semibold text-brand-navy underline" data-testid="tile-week-setplan">Set weekly plan →</Link>
      ) : null}
    </>
  );
}
