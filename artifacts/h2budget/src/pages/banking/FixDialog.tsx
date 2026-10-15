import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import {
  useApplyReviewProposal,
  type AppliedCorrection,
  type CorrectionPreview,
  type ReviewProposal,
} from "@workspace/api-client-react/features";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { OWN_INVALIDATION } from "@/lib/mutationInvalidation";
import { btn, btnSecondary } from "@/ui";
import { cn, formatCurrency } from "@/lib/utils";
import { figureChanges, limitationWords, refusalCode, refusalWords, rowChangeWords } from "./fixWords";
import { dayWords } from "./words";

/**
 * (Q5) PREVIEW, then APPLY — one dialog. Opening it asks the server for a dry
 * run (writes nothing): which rows change and how, which totals move
 * (before → after, the same builders the screens read). Apply is on only once
 * that answer is in, and asks once more ("Apply this fix?") before it writes.
 * A refused fix (the proposal changed, a row is gone) shows the server's line.
 * The dry run is for THIS proposal and hash; a different proposal or a changed
 * hash is a different preview.
 */
export interface FixDialogProps {
  proposal: ReviewProposal;
  title: string;
  /** Where each row opens (txnRoute); null href = no ledger lists it */
  hrefOf: (row: ReviewProposal["rows"][number]) => string | null;
  onClose: () => void;
  /** Called with the server's record after a successful apply */
  onApplied: (applied: AppliedCorrection, title: string) => void;
  /** Open on the confirm step (the card's Apply button) */
  startConfirming?: boolean;
  /** Where focus goes when the dialog closes (the button that opened it); Radix has no trigger here to return to */
  returnFocus?: () => HTMLElement | null;
}

export function FixDialog({ proposal, title, hrefOf, onClose, onApplied, startConfirming = false, returnFocus }: FixDialogProps) {
  const dry = useApplyReviewProposal({ mutation: { meta: OWN_INVALIDATION } });
  const write = useApplyReviewProposal({ mutation: { meta: OWN_INVALIDATION } });
  const [preview, setPreview] = useState<CorrectionPreview | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(startConfirming);
  const [refused, setRefused] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const body = { rowIds: proposal.rows.map((r) => r.id), proposalHash: proposal.proposalHash };
  // One dry run per proposal+hash; a changed proposal is a new dialog.
  useEffect(() => {
    setPreview(null);
    setFailed(null);
    dry.mutate(
      { key: proposal.key, data: body, params: { dryRun: "1" } },
      {
        onSuccess: (r) => live.current && setPreview(r as CorrectionPreview),
        onError: (e) => live.current && setFailed(refusalWords(e, "H2 could not preview this fix. Try again.")),
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal.key, proposal.proposalHash]);

  const changes = preview ? figureChanges(preview) : [];
  const limits = preview ? limitationWords(preview.limitations) : null;
  const ready = !!preview && !write.isPending && !refused;

  const apply = () => {
    if (!ready) return;
    // mutateAsync, not mutate's callbacks: the result reaches `onApplied` (refresh + the Undo toast) even if
    // this dialog is gone by then. Only the screen-local refusal text needs the dialog to be alive.
    write.mutateAsync({ key: proposal.key, data: body }).then(
      (r) => onApplied(r as AppliedCorrection, title),
      (e) => {
        if (!live.current) return;
        const code = refusalCode(e);
        setConfirming(false);
        setRefused(
          code === "already_applied" ? "This fix was already applied." : refusalWords(e, "H2 could not apply this fix. Nothing was changed."),
        );
      },
    );
  };

  // While the write runs the dialog stays: closing it would only hide the answer.
  const busy = write.isPending;

  return (
    <Dialog open onOpenChange={(o) => (o || busy ? null : onClose())}>
      <DialogContent
        className={cn("max-h-[90vh] max-w-xl overflow-y-auto", busy && "[&>button:last-child]:hidden")}
        data-testid="fix-dialog"
        onEscapeKeyDown={(e) => busy && e.preventDefault()}
        onInteractOutside={(e) => busy && e.preventDefault()}
        onCloseAutoFocus={(e) => {
          // Back to the control that opened this (Escape, Cancel, X and Apply all land here).
          const el = returnFocus?.();
          if (el) {
            e.preventDefault();
            el.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{confirming ? "Apply this fix?" : "Preview"} · {title}</DialogTitle>
          <DialogDescription>{confirming ? "It changes the rows and totals below. You can undo it." : "Nothing changes until you apply."}</DialogDescription>
        </DialogHeader>

        {failed ? (
          <p className="text-label text-bad" role="alert" data-testid="fix-failed">{failed}</p>
        ) : !preview ? (
          <div className="space-y-2" aria-busy="true" data-testid="fix-loading">
            <div className="skeleton h-14 w-full rounded-card" />
            <div className="skeleton h-10 w-full rounded-card" />
          </div>
        ) : (
          <div className="space-y-3">
            <section data-testid="fix-rows">
              <h3 className="text-label font-semibold text-brand-navy">{preview.rows.length} {preview.rows.length === 1 ? "row" : "rows"}</h3>
              <ul className="mt-1 divide-y divide-brand-line/70">
                {preview.rows.map((row) => {
                  const src = proposal.rows.find((r) => r.id === row.id);
                  const href = src ? hrefOf(src) : null;
                  const name = <span className="min-w-0 truncate font-medium text-brand-ink">{row.displayName}</span>;
                  return (
                    <li key={row.id} className="py-1.5" data-testid="fix-row">
                      <div className="flex items-baseline justify-between gap-3 text-label">
                        <span className="flex min-w-0 items-baseline gap-2">
                          <span className="shrink-0 text-neutral-500">{dayWords(row.date)}</span>
                          {href ? <Link href={href} className="min-w-0 truncate hover:underline" data-testid="fix-row-link">{name}</Link> : name}
                        </span>
                        <span className="shrink-0 font-mono tabular-nums text-brand-ink">{formatCurrency(row.amount)}</span>
                      </div>
                      <ul className="text-micro text-neutral-600" data-testid="fix-row-change">
                        {rowChangeWords(row, proposal).map((w) => <li key={w}>{w}</li>)}
                      </ul>
                    </li>
                  );
                })}
              </ul>
            </section>

            <section data-testid="fix-totals">
              <h3 className="text-label font-semibold text-brand-navy">Totals that change</h3>
              {changes.length === 0 ? (
                <p className="mt-1 text-label text-neutral-600" data-testid="fix-no-change">No total changes.</p>
              ) : (
                <dl className="mt-1 space-y-1">
                  {changes.map((c) => (
                    <div key={c.key} className="flex flex-wrap items-baseline justify-between gap-x-3 text-label" data-testid="fix-change">
                      <dt className="text-neutral-700"><span className="text-neutral-500">{c.scope} · </span>{c.label}</dt>
                      <dd className="font-mono tabular-nums text-brand-ink">{c.before} → {c.after}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </section>

            {preview.replaces.length > 0 ? (
              <p className="text-micro text-neutral-600" data-testid="fix-replaces">
                Replaces {preview.replaces.length} earlier {preview.replaces.length === 1 ? "answer" : "answers"}. Undo puts {preview.replaces.length === 1 ? "it" : "them"} back.
              </p>
            ) : null}
            {preview.learnsMemory ? <p className="text-micro text-neutral-600" data-testid="fix-learns">H2 files this merchant the same way next time.</p> : null}
            {limits ? <p className="text-micro text-neutral-600" data-testid="fix-limits">{limits}</p> : null}
          </div>
        )}

        {refused ? <p className="text-label text-bad" role="alert" data-testid="fix-refused">{refused}</p> : null}

        <DialogFooter>
          <button type="button" className={btnSecondary} disabled={busy} onClick={onClose} data-testid="fix-cancel">{refused ? "Close" : "Cancel"}</button>
          {confirming ? (
            <button type="button" className={btn} disabled={!ready} onClick={apply} data-testid="fix-confirm-go">
              {write.isPending ? "Applying…" : "Yes, apply"}
            </button>
          ) : (
            <button type="button" className={btn} disabled={!ready} onClick={() => setConfirming(true)} data-testid="fix-apply">Apply…</button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
