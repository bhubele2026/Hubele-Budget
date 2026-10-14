import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetMe, type AmexSummaryCard } from "@workspace/api-client-react";
import { useSetAmexCardPayoffMode } from "@workspace/api-client-react/features";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { btn, btnSecondary } from "@/ui";
import { planErrorWords } from "@/lib/planWords";

/**
 * (F4) "How this card is paid" — In full (weekly / monthly) or Paying down
 * (minimum + extra). Shown from the server's answer (`payoffMode` on the
 * summary's cards). Only the household owner can change it, and only through
 * the confirm dialog: H2 never sets it by itself. A card with no answer yet
 * says so (plans are paused for it) and asks the owner to choose.
 */
type Mode = "in_full" | "debt_plan";

export function payModeWords(card: Pick<AmexSummaryCard, "payoffMode" | "cadence">): string {
  const m = card.payoffMode?.mode ?? null;
  if (m === "debt_plan") return "Paying down (minimum + extra)";
  if (m === "in_full") return card.cadence === "monthly" ? "In full monthly" : "In full weekly";
  return "Not chosen yet";
}

export function paySourceWords(card: Pick<AmexSummaryCard, "payoffMode">): string {
  const p = card.payoffMode;
  if (!p) return "";
  if (p.source === "explicit") return "Chosen by you";
  return p.mode == null ? "H2 can't tell from the debt" : "Default from the card's debt";
}

function whatItDoes(mode: Mode, cadence: AmexSummaryCard["cadence"]): string {
  return mode === "in_full"
    ? `Purchases are planned as a payment in full each ${cadence === "monthly" ? "month" : "week"}. No separate minimum.`
    : "Planned as the minimum plus extra toward the debt. Purchases are not planned as a weekly payment.";
}

export function CardPayMode({ card }: { card: AmexSummaryCard }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const me = useGetMe({ query: { staleTime: 30 * 60_000 } as never });
  const canSet = me.data ? (me.data as { isOwner?: boolean }).isOwner === true : false;
  const save = useSetAmexCardPayoffMode();
  const [pick, setPick] = useState<Mode | "default" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const label = `${card.name}${card.mask ? ` ••${card.mask}` : ""}`;

  const close = () => {
    setPick(null);
    setError(null);
  };
  const confirm = () => {
    if (!pick) return;
    save.mutate(
      { accountId: card.accountId, data: { mode: pick === "default" ? null : pick } },
      {
        onSuccess: () => {
          void qc.invalidateQueries({
            predicate: (q) => typeof q.queryKey[0] === "string" && /^\/api\/(amex|forecast|money|allowance-plans)/.test(q.queryKey[0]),
          });
          toast({ title: "Card payment updated." });
          close();
        },
        onError: (e) => setError(planErrorWords(e)),
      },
    );
  };
  const current = card.payoffMode?.mode ?? null;
  const options: Array<{ key: Mode | "default"; text: string }> = [
    { key: "in_full", text: card.cadence === "monthly" ? "In full monthly" : "In full weekly" },
    { key: "debt_plan", text: "Paying down (minimum + extra)" },
    ...(card.payoffMode?.source === "explicit" ? [{ key: "default" as const, text: "Use the default" }] : []),
  ];
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-body" data-testid={`amex-paymode-${card.accountId}`}>
      <span className="text-neutral-600">{card.name}{card.mask ? ` ••${card.mask}` : ""}:</span>
      <span className="font-semibold text-brand-ink" data-testid="amex-paymode-word">{payModeWords(card)}</span>
      <span className="text-micro text-neutral-600" data-testid="amex-paymode-source">{paySourceWords(card)}</span>
      {canSet ? (
        <button type="button" className="press text-label font-semibold text-brand-navy underline" onClick={() => setPick(current ?? "in_full")} data-testid="amex-paymode-change">
          Change
        </button>
      ) : null}
      <Dialog open={pick != null} onOpenChange={(o) => (o ? null : close())}>
        <DialogContent data-testid="amex-paymode-dialog">
          <DialogHeader>
            <DialogTitle>How is {label} paid?</DialogTitle>
            <DialogDescription>Nothing changes until you confirm.</DialogDescription>
          </DialogHeader>
          <div role="radiogroup" aria-label="How this card is paid" className="space-y-1.5">
            {options.map((o) => (
              <button
                key={o.key}
                type="button"
                role="radio"
                aria-checked={pick === o.key}
                onClick={() => setPick(o.key)}
                data-testid={`amex-paymode-opt-${o.key}`}
                className={`press block w-full rounded-control px-3 py-2 text-left text-body ring-1 ${pick === o.key ? "bg-brand-tint ring-2 ring-brand-navy" : "bg-white ring-brand-line hover:bg-neutral-50"}`}
              >
                {o.text}
              </button>
            ))}
          </div>
          {pick && pick !== "default" ? <p className="text-label text-neutral-600" data-testid="amex-paymode-effect">{whatItDoes(pick, card.cadence)}</p> : null}
          {pick === "default" ? <p className="text-label text-neutral-600">H2 goes back to reading it from the card's debt.</p> : null}
          {error ? <p className="text-label text-bad" role="alert">{error}</p> : null}
          <DialogFooter>
            <button type="button" className={btnSecondary} onClick={close} data-testid="amex-paymode-cancel">Cancel</button>
            <button type="button" className={btn} disabled={save.isPending} onClick={confirm} data-testid="amex-paymode-go">Confirm</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The summary's "How this card is paid" block: the one card in scope, or each card on All cards. */
export function CardPayModes({ cards }: { cards: readonly AmexSummaryCard[] }) {
  if (cards.length === 0) return null;
  return (
    <div className="space-y-1" data-testid="amex-paymodes">
      <div className="text-micro font-semibold uppercase tracking-wide text-neutral-500">How {cards.length === 1 ? "this card is" : "cards are"} paid</div>
      {cards.map((c) => <CardPayMode key={c.accountId} card={c} />)}
    </div>
  );
}
