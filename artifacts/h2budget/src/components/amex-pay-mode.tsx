import { useId, useState, type ReactNode } from "react";
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
 * (minimum + extra). Shown from the server's answer (`paidAs`, `payDown`,
 * `defaultMode` on the summary's cards). Only the household owner can change
 * it, and only through the confirm dialog: H2 never sets it by itself.
 *
 * ⭐ (P1) WORDS THAT CANNOT BE MISREAD. The block says the mode in effect, one
 * line of what it means, and — behind "Why this?" — where the answer came from.
 * "Default: its debt is paid off" is gone: next to a card that still owes money
 * it read as "this card is paid off". The default now says what H2 read (the
 * card's entry on the debt plan is closed) and that closing it changes nothing
 * the card owes. When Paying down cannot take effect, a plain fix line says what
 * is missing and where to add it; the dialog and the toasts reuse those words.
 */
type Mode = "in_full" | "debt_plan";

type PayDownReason = NonNullable<AmexSummaryCard["payDown"]["reason"]>;

/** Why Paying down cannot take effect, as a fix: the sentence, where to fix it, and the toast's tail. */
export type PayRemedy = { reason: PayDownReason; text: string; link: string; toastTail: string };

const REMEDY: Record<PayDownReason, Omit<PayRemedy, "reason">> = {
  no_debt: { text: "Paying down needs this card on the debt plan.", link: "Add it in Debts", toastTail: "Add it in Debts." },
  debt_not_active: {
    text: "Paying down needs this card's debt-plan entry to be open; it's closed.",
    link: "Open Debts",
    toastTail: "Reopen it in Debts.",
  },
  debt_terms_missing: {
    text: "Paying down needs the card's APR and minimum payment.",
    link: "Add them in Debts",
    toastTail: "Add them in Debts.",
  },
};

/**
 * (Q6b) Why "Paying down" cannot take effect, from the server's own answer
 * (`payDown`, one rule in cardPayoffMode.ts): the words follow the cause.
 */
export function payRemedy(card: Pick<AmexSummaryCard, "payDown">): PayRemedy | null {
  const p = card.payDown;
  if (!p || p.available) return null;
  const reason = p.reason ?? "no_debt";
  return { reason, ...REMEDY[reason] };
}

/**
 * (Q6b r3) Why "Use the default" would not take effect: the server's own answer
 * (`defaultMode`, `resolvePayoffMode` with no choice). Only one cause exists
 * (an active debt-plan entry with no APR and no minimum).
 */
const DEFAULT_REMEDY = { text: "The default needs the card's APR and minimum payment.", link: "Add them in Debts", toastTail: "Add them in Debts." };
function defaultRemedy(card: Pick<AmexSummaryCard, "defaultMode">): typeof DEFAULT_REMEDY | null {
  if (!card.defaultMode || card.defaultMode.mode != null) return null;
  return DEFAULT_REMEDY;
}

type PayCard = Pick<AmexSummaryCard, "payoffMode" | "cadence"> & {
  paidAs?: AmexSummaryCard["paidAs"];
  payDown?: AmexSummaryCard["payDown"];
};

/** Paying down was chosen but cannot take effect (no open debt-plan entry, or no terms): saved, not in effect. */
export function payingDownNotInEffect(card: Pick<AmexSummaryCard, "payoffMode">): boolean {
  return card.payoffMode?.reason === "debt_plan_without_active_debt";
}

/** The mode in effect, from `paidAs` (the single payoff-mode definition); the older `payoffMode` only when `paidAs` is absent. */
function effectiveMode(card: PayCard): "in_full_weekly" | "in_full_monthly" | "debt_plan" | "unset" {
  const m = card.paidAs?.effectiveMode ?? legacyMode(card);
  return m === "debt_plan" || m === "in_full_monthly" || m === "in_full_weekly" ? m : "unset";
}

/** (Q1) The one label set: the mode in effect, or that Paying down was chosen but is not in effect yet. */
export function payModeWords(card: PayCard): string {
  if (payingDownNotInEffect(card)) return "Paying down — not in effect yet";
  const m = effectiveMode(card);
  if (m === "debt_plan") return "Paying down (minimum + extra)";
  if (m === "in_full_monthly") return "Paid in full monthly";
  if (m === "in_full_weekly") return "Paid in full weekly";
  return "Not chosen yet";
}

/** (P1) The short word a card's line in the By card list carries. */
export function payWordShort(card: PayCard): string {
  if (payingDownNotInEffect(card)) return "Not chosen yet";
  const m = effectiveMode(card);
  if (m === "debt_plan") return "Paying down";
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

/** One line of what the mode in effect does to the plan. */
function whatItDoes(mode: Mode, cadence: AmexSummaryCard["cadence"]): string {
  return mode === "in_full"
    ? `Purchases are planned as a payment in full each ${cadence === "monthly" ? "month" : "week"}. No separate minimum.`
    : "Planned as the minimum plus extra toward the debt. Purchases are not planned as a weekly payment.";
}

/** (P1) What the mode in effect means, in one line. */
export function payMeaning(card: PayCard): string {
  if (payingDownNotInEffect(card)) return "Until then, its purchases are planned as paid in full, and plans are paused.";
  const m = effectiveMode(card);
  if (m === "debt_plan") return whatItDoes("debt_plan", card.cadence);
  if (m === "in_full_weekly" || m === "in_full_monthly") return whatItDoes("in_full", m === "in_full_monthly" ? "monthly" : card.cadence);
  return "Until then, its purchases are planned as paid in full, and plans are paused.";
}

/** (P1) "Why this?": where the answer came from, by `paidAs.source` (the older `payoffMode` when absent). */
export function paySourceWords(card: PayCard): string {
  if (payingDownNotInEffect(card)) return "Set by the household owner.";
  const src = card.paidAs?.source;
  if (src === "chosen") return "Set by the household owner.";
  if (src === "default_no_debt") return "H2's default: this card isn't on the debt plan, so its purchases are paid in full.";
  if (src === "default_debt_inactive") {
    return "H2's default: this card's entry on the debt plan is closed, so its purchases are paid in full. Closing that entry doesn't change what the card owes — that's the Owed figure above.";
  }
  if (src === "default_debt_active") return "H2's default: this card is on the debt plan with an APR or minimum, so it's paid down.";
  if (src === "needs_choice") return "H2 can't tell: this card's entry on the debt plan has no APR or minimum payment.";
  const p = card.payoffMode;
  if (!p) return "";
  if (p.source === "explicit") return "Set by the household owner.";
  return p.mode == null
    ? "H2 can't tell: this card's entry on the debt plan has no APR or minimum payment."
    : "H2's default, read from the card's entry on the debt plan.";
}

/** The fix line shows only when the card has no mode in effect, or Paying down was chosen and cannot apply. */
export function showsRemedy(card: PayCard): boolean {
  return payingDownNotInEffect(card) || effectiveMode(card) === "unset";
}

export function CardPayMode({
  card,
  showName = true,
  addNode,
}: {
  card: AmexSummaryCard;
  showName?: boolean;
  /** (P1) "+ Add to Avalanche" for a card not on the debt plan: the no-debt fix, or its own line. */
  addNode?: ReactNode;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  // (Q4) Owner is true, false or unknown. "Change" is an extra link, not a denial: unknown holds its place.
  const owner = useOwner();
  const canSet = owner === true;
  const save = useSetAmexCardPayoffMode();
  const [pick, setPick] = useState<Mode | "default" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [whyOpen, setWhyOpen] = useState(false);
  const whyId = useId();
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
            const r =
              pick === "default"
                ? DEFAULT_REMEDY
                : (payRemedy({ payDown: a.payDown ?? card.payDown }) ?? REMEDY.no_debt);
            toast({ title: "Saved, not in effect.", description: `${r.text} ${r.toastTail}` });
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
  const block = payRemedy(card);
  const debtMissing = block != null;
  const defBlock = defaultRemedy(card);
  const effectless = (pick === "debt_plan" && debtMissing) || (pick === "default" && defBlock != null);
  const options: Array<{ key: Mode | "default"; text: string }> = [
    { key: "in_full", text: card.cadence === "monthly" ? "Paid in full monthly" : "Paid in full weekly" },
    { key: "debt_plan", text: "Paying down (minimum + extra)" },
    ...(card.payoffMode?.source === "explicit" ? [{ key: "default" as const, text: "Use the default" }] : []),
  ];
  // The fix line, when the card has no mode in effect: the cause, and where to fix it.
  const remedy = showsRemedy(card) ? block : null;
  const addInRemedy = remedy?.reason === "no_debt" && addNode != null;
  const LINKC = "font-semibold text-brand-navy underline";
  return (
    <div className="space-y-1 text-body" data-testid={`amex-paymode-${card.accountId}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {showName ? <span className="text-neutral-600">{label}:</span> : null}
        <span className="font-semibold text-brand-ink" data-testid="amex-paymode-word">{payModeWords(card)}</span>
        {canSet ? (
          <button type="button" className="press text-label font-semibold text-brand-navy underline" onClick={() => setPick(current ?? "in_full")} data-testid="amex-paymode-change">
            Change
          </button>
        ) : owner === "unknown" ? (
          <span className="inline-block h-4 w-12 animate-pulse rounded bg-platinum-2 align-middle" aria-hidden data-testid="amex-paymode-owner-unknown" />
        ) : null}
      </div>
      <p className="text-label text-neutral-600" data-testid="amex-paymode-meaning">{payMeaning(card)}</p>
      {remedy ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-label text-brand-ink" data-testid="amex-paymode-remedy">
          <span>{remedy.text}</span>
          {addInRemedy ? (
            addNode
          ) : (
            <Link href="/debts" className={LINKC} data-testid="amex-paymode-debts-link">{remedy.link}</Link>
          )}
        </p>
      ) : null}
      {addNode != null && !addInRemedy ? <div data-testid="amex-paymode-add">{addNode}</div> : null}
      <div>
        <button
          type="button"
          className="press inline-flex min-h-8 items-center text-label font-semibold text-brand-navy underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40"
          aria-expanded={whyOpen}
          aria-controls={whyId}
          onClick={() => setWhyOpen((o) => !o)}
          data-testid="amex-paymode-why"
        >
          Why this?
        </button>
        <p id={whyId} hidden={!whyOpen} className="text-label text-neutral-600" data-testid="amex-paymode-source">
          {paySourceWords(card)}
        </p>
      </div>
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
              {block.text}{" "}
              <Link href="/debts" className={LINKC} data-testid="amex-paymode-debt-link">{block.link}</Link>
            </p>
          ) : null}
          {/* (Q6b r3 review A) Only when "Use the default" is offered, and never the same cause twice. */}
          {defBlock && options.some((o) => o.key === "default") && block?.reason !== "debt_terms_missing" ? (
            <p className="text-label text-neutral-600" data-testid="amex-paymode-default-reason">
              {defBlock.text}{" "}
              <Link href="/debts" className={LINKC} data-testid="amex-paymode-default-link">{defBlock.link}</Link>
            </p>
          ) : null}
          {pick && pick !== "default" && !effectless ? <p className="text-label text-neutral-600" data-testid="amex-paymode-effect">{whatItDoes(pick, card.cadence)}</p> : null}
          {pick === "default" && !effectless ? <p className="text-label text-neutral-600">H2 goes back to reading it from the card's entry on the debt plan.</p> : null}
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

/** The single card's "How this card is paid" block (P1: the one card in scope; All cards shows a word per card). */
export function CardPayModes({ cards, addNode }: { cards: readonly AmexSummaryCard[]; addNode?: ReactNode }) {
  if (cards.length === 0) return null;
  return (
    <div className="space-y-1" data-testid="amex-paymodes">
      <div className="text-label text-neutral-600">How {cards.length === 1 ? "this card is" : "cards are"} paid</div>
      {cards.map((c) => (
        <CardPayMode key={c.accountId} card={c} showName={cards.length > 1} addNode={cards.length === 1 ? addNode : undefined} />
      ))}
    </div>
  );
}
