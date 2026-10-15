import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import type { AmexSummaryCard } from "@workspace/api-client-react";
import { useOwner } from "@/hooks/useOwner";
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

type PayDownReason = NonNullable<AmexSummaryCard["payDown"]["reason"]>;

/**
 * (Q6b) Why "Paying down" cannot take effect, from the server's own answer
 * (`payDown`, one rule in cardPayoffMode.ts): the words follow the cause.
 */
function payDownBlock(card: Pick<AmexSummaryCard, "payDown">): { reason: PayDownReason; line: string; link: string; short: string } | null {
  const p = card.payDown;
  if (!p || p.available) return null;
  const reason = p.reason ?? "no_debt";
  return reason === "debt_terms_missing"
    ? { reason, line: "Add the debt's APR and minimum in", link: "Debts", short: "Paying down needs the debt's APR and minimum" }
    : { reason, line: "Needs an active debt —", link: "Add it in Debts", short: "Paying down needs an active debt" };
}

/**
 * (Q6b r3) Why "Use the default" would not take effect: the server's own answer
 * (`defaultMode`, `resolvePayoffMode` with no choice). Only one cause exists
 * (an active debt with no APR and no minimum), worded as Paying down is.
 */
function defaultBlock(card: Pick<AmexSummaryCard, "defaultMode">): { line: string; link: string; short: string } | null {
  if (!card.defaultMode || card.defaultMode.mode != null) return null;
  return { line: "Add the debt's APR and minimum in", link: "Debts", short: "The default needs the debt's APR and minimum" };
}

/** (Q1) The one label set, read from `paidAs` (the single payoff-mode definition); the older `payoffMode` only when `paidAs` is absent. */
export function payModeWords(card: Pick<AmexSummaryCard, "payoffMode" | "cadence"> & { paidAs?: AmexSummaryCard["paidAs"] }): string {
  const m = card.paidAs?.effectiveMode ?? legacyMode(card);
  if (m === "debt_plan") return "Paying down (minimum + extra)";
  if (m === "in_full_monthly") return "Paid in full monthly";
  if (m === "in_full_weekly") return "Paid in full weekly";
  return "Not chosen yet";
}

function legacyMode(card: Pick<AmexSummaryCard, "payoffMode" | "cadence">): string {
  const m = card.payoffMode?.mode ?? null;
  if (m === "debt_plan") return "debt_plan";
  if (m === "in_full") return card.cadence === "monthly" ? "in_full_monthly" : "in_full_weekly";
  return "unset";
}

/** Paying down was chosen but the card has no active debt: saved, not in effect. */
export function payingDownNotInEffect(card: Pick<AmexSummaryCard, "payoffMode">): boolean {
  return card.payoffMode?.reason === "debt_plan_without_active_debt";
}

/** The saved-but-not-in-effect words, by the cause (the toast and the source line share them). */
function notInEffectWords(card: Pick<AmexSummaryCard, "payDown">): string {
  return payDownBlock(card)?.short ?? "Paying down needs an active debt";
}

export function paySourceWords(card: Pick<AmexSummaryCard, "payoffMode"> & { paidAs?: AmexSummaryCard["paidAs"]; payDown?: AmexSummaryCard["payDown"] }): string {
  if (payingDownNotInEffect(card)) return notInEffectWords({ payDown: card.payDown as AmexSummaryCard["payDown"] });
  const src = card.paidAs?.source;
  if (src === "chosen") return "Chosen by you";
  if (src === "default_no_debt") return "Default: no debt on this card";
  if (src === "default_debt_inactive") return "Default: its debt is paid off";
  if (src === "default_debt_active") return "Default from the card's debt";
  if (src === "needs_choice") return "H2 can't tell from the debt";
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

export function CardPayMode({ card, showName = true }: { card: AmexSummaryCard; showName?: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  // (Q4) Owner is true, false or unknown. "Change" is an extra link, not a denial: unknown holds its place.
  const owner = useOwner();
  const canSet = owner === true;
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
        onSuccess: (answer) => {
          void qc.invalidateQueries({
            predicate: (q) => typeof q.queryKey[0] === "string" && /^\/api\/(amex|forecast|money|allowance-plans)/.test(q.queryKey[0]),
          });
          // Saved, but a choice that resolves to no mode is not in effect: say so, never "updated".
          // The words come from the server's answer (never the card as last shown).
          const a = answer as { mode?: string | null; payDown?: AmexSummaryCard["payDown"] } | undefined;
          if (a?.mode === null) {
            const b = payDownBlock({ payDown: a.payDown ?? card.payDown });
            toast({
              title: "Saved, not in effect.",
              description:
                pick === "default"
                  ? "Add the debt's APR and minimum in Debts."
                  : b?.reason === "debt_terms_missing"
                    ? "Add the debt's APR and minimum in Debts."
                    : "Paying down needs an active debt. Add it in Debts.",
            });
          } else {
            toast({ title: "Card payment updated." });
          }
          close();
        },
        onError: (e) => setError(planErrorWords(e)),
      },
    );
  };
  const current = card.paidAs?.effectiveMode === "unset" ? null : (card.payoffMode?.mode ?? null);
  // Paying down is offered only when the server says it can take effect (`payDown`); the cause words the reason.
  const block = payDownBlock(card);
  const debtMissing = block != null;
  const defBlock = defaultBlock(card);
  const effectless = (pick === "debt_plan" && debtMissing) || (pick === "default" && defBlock != null);
  const options: Array<{ key: Mode | "default"; text: string }> = [
    { key: "in_full", text: card.cadence === "monthly" ? "Paid in full monthly" : "Paid in full weekly" },
    { key: "debt_plan", text: "Paying down (minimum + extra)" },
    ...(card.payoffMode?.source === "explicit" ? [{ key: "default" as const, text: "Use the default" }] : []),
  ];
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-body" data-testid={`amex-paymode-${card.accountId}`}>
      {showName ? <span className="text-neutral-600">{card.name}{card.mask ? ` ••${card.mask}` : ""}:</span> : null}
      <span className="font-semibold text-brand-ink" data-testid="amex-paymode-word">{payModeWords(card)}</span>
      <span className="text-micro text-neutral-600" data-testid="amex-paymode-source">{paySourceWords(card)}</span>
      {payingDownNotInEffect(card) ? (
        <Link href="/debts" className="text-label font-semibold text-brand-navy underline" data-testid="amex-paymode-debts-link">Debts</Link>
      ) : null}
      {canSet ? (
        <button type="button" className="press text-label font-semibold text-brand-navy underline" onClick={() => setPick(current ?? "in_full")} data-testid="amex-paymode-change">
          Change
        </button>
      ) : owner === "unknown" ? (
        <span className="inline-block h-4 w-12 animate-pulse rounded bg-platinum-2 align-middle" aria-hidden data-testid="amex-paymode-owner-unknown" />
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
                aria-disabled={(o.key === "debt_plan" && debtMissing) || (o.key === "default" && defBlock) ? true : undefined}
                disabled={(o.key === "debt_plan" && debtMissing) || (o.key === "default" && defBlock != null)}
                onClick={() => setPick(o.key)}
                data-testid={`amex-paymode-opt-${o.key}`}
                className={`press block w-full rounded-control px-3 py-2 text-left text-body ring-1 disabled:cursor-not-allowed disabled:text-neutral-500 ${pick === o.key ? "bg-brand-tint ring-2 ring-brand-navy" : "bg-white ring-brand-line hover:bg-neutral-50"}`}
              >
                {o.text}
              </button>
            ))}
          </div>
          {block ? (
            <p className="text-label text-neutral-600" data-testid="amex-paymode-debt-reason">
              {block.line}{" "}
              <Link href="/debts" className="font-semibold text-brand-navy underline" data-testid="amex-paymode-debt-link">{block.link}</Link>
            </p>
          ) : null}
          {/* (Q6b r3 review A) Only when "Use the default" is offered, and never the payDown line again. */}
          {defBlock && options.some((o) => o.key === "default") && defBlock.line !== block?.line ? (
            <p className="text-label text-neutral-600" data-testid="amex-paymode-default-reason">
              {defBlock.line}{" "}
              <Link href="/debts" className="font-semibold text-brand-navy underline" data-testid="amex-paymode-default-link">{defBlock.link}</Link>
            </p>
          ) : null}
          {pick && pick !== "default" && !effectless ? <p className="text-label text-neutral-600" data-testid="amex-paymode-effect">{whatItDoes(pick, card.cadence)}</p> : null}
          {pick === "default" && !effectless ? <p className="text-label text-neutral-600">H2 goes back to reading it from the card's debt.</p> : null}
          {error ? <p className="text-label text-bad" role="alert">{error}</p> : null}
          <DialogFooter>
            <button type="button" className={btnSecondary} onClick={close} data-testid="amex-paymode-cancel">Cancel</button>
            <button type="button" className={btn} disabled={save.isPending || effectless} onClick={confirm} data-testid="amex-paymode-go">Confirm</button>
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
      {cards.map((c) => <CardPayMode key={c.accountId} card={c} showName={cards.length > 1} />)}
    </div>
  );
}
