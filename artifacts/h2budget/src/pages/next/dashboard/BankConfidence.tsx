import type { Spine } from "@workspace/api-client-react";
import { identityOf } from "@/lib/accountIdentity";
import { bankBalanceView } from "@/lib/bankBalance";
import { checkedAgo, confidenceView } from "@/lib/bankConfidenceView";
import { cn } from "@/lib/utils";

/**
 * (Q5) Can the checking balance be trusted? Four separate facts (the fetch, the
 * check, the pending rows) from `spine.bankConfidence`; words in
 * `lib/bankConfidenceView`. A lazy chunk: the landing carries neither the words
 * nor this markup, only a same-size placeholder until it arrives. Green only for
 * a check that matched and is fresh.
 */
const chipTone = (t: "ok" | "bad" | "grey") => (t === "grey" ? "gray" : t);

export default function BankConfidence({ s, variant }: { s: Spine; variant: "tile" | "header" }) {
  const bc = s.bankConfidence;
  const v = bankBalanceView(s.bank);
  if (!bc || v.balance == null) return null;
  const conf = confidenceView(bc);
  // (T2) The header names when, beside the same chip words as Banking: "Checked 2 h ago · difference needs review".
  const ago = bc.check.checkedAt ? checkedAgo(bc.check.checkedAt, Date.now()) : null;
  const headerCheck =
    bc.check.status === "off_by" && !bc.check.stale && ago ? `Checked ${ago} · ${conf.check.word.toLowerCase()}` : conf.check.word;
  if (variant === "tile") {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-micro" data-testid="tile-banking-confidence">
        <span className={cn("chip", chipTone(conf.check.tone))} data-testid="tile-banking-check" data-tone={conf.check.tone}>{conf.check.word}</span>
        {conf.pending ? <span className="text-neutral-600" data-testid="tile-banking-pending">{conf.pending}</span> : null}
      </div>
    );
  }
  const acct = v.account;
  const identity = acct ? identityOf({ id: "cash", name: acct.name, mask: acct.mask, subtype: acct.subtype, type: "depository", institutionName: null }) : null;
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-neutral-600" data-testid="dash-bank-confidence" data-tone={conf.tone}>
      <span>
        <span
          aria-hidden
          className={cn("mr-1.5 inline-block size-1.5 rounded-full align-middle", conf.tone === "ok" ? "bg-acct-checking" : conf.tone === "bad" ? "bg-bad" : "bg-neutral-400")}
        />
        <span className="font-semibold text-neutral-700">{identity ? `${identity.label}${identity.mask4 ? ` ••${identity.mask4}` : ""}` : "Checking"}</span>
      </span>
      {conf.updated ? <span data-testid="dash-bank-updated">{conf.updated}</span> : null}
      <span className={cn(conf.tone === "bad" && "font-semibold text-bad-ink")} data-testid="dash-bank-check">{headerCheck}</span>
      {conf.pending ? <span data-testid="dash-bank-pending">{conf.pending}</span> : null}
    </p>
  );
}
