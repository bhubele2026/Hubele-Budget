import type { Spine } from "@workspace/api-client-react";
import { bankBalanceView } from "@/lib/bankBalance";
import { confidenceView } from "@/lib/bankConfidenceView";
import { cn } from "@/lib/utils";

/**
 * (Q5) Can the checking balance be trusted? The CHECK, on the Banking tile: one chip from
 * `spine.bankConfidence.check` (words in `lib/bankConfidenceView`). Freshness and the pending
 * count are the tile's row above it, never merged with this and never colouring it. A lazy
 * chunk: the landing carries neither the words nor this markup, only a same-size placeholder
 * until it arrives. Green only for a check that matched and is fresh.
 */
const chipTone = (t: "ok" | "bad" | "grey") => (t === "grey" ? "gray" : t);

export default function BankConfidence({ s }: { s: Spine }) {
  const bc = s.bankConfidence;
  const v = bankBalanceView(s.bank);
  if (!bc || v.balance == null) return null;
  const conf = confidenceView(bc);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="tile-banking-confidence">
      <span className={cn("chip", chipTone(conf.check.tone))} data-testid="tile-banking-check" data-tone={conf.check.tone}>{conf.check.word}</span>
    </div>
  );
}
