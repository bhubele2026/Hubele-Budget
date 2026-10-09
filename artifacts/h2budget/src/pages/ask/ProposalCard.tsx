import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useApproveAgentProposal,
  useRejectAgentProposal,
  type AgentProposal,
} from "@workspace/api-client-react/features";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { OWN_INVALIDATION } from "@/lib/mutationInvalidation";
import { shortDateOfInstant } from "@/lib/dates";
import { apiMessage } from "@/lib/apiMessage";
import { KIND_WORD, PROPOSAL_STATUS_WORD, describeChange, refHref } from "@/lib/askWords";
import { StatusChip, type Tone } from "@/pages/settings/parts";
import { btn, btnSecondarySm, btnSm } from "@/ui";
import { PROPOSALS_PREFIX } from "./askData";

const TONE: Record<AgentProposal["status"], Tone> = {
  proposed: "tight",
  approved: "fresh",
  applied: "fresh",
  rejected: "stale",
  expired: "stale",
};

/** The server's reason for each refusal, in its own words where it sends them. */
export function decisionError(e: unknown, verb: "apply" | "reject"): string {
  const status = (e as { status?: number } | null)?.status;
  if (status === 409) return "This is no longer open, or what it changes has moved. Nothing changed.";
  if (status === 404) return "H2 could not find this proposal. Nothing changed.";
  return apiMessage(e, `Couldn't ${verb} that. Nothing changed.`);
}

/**
 * ⭐ (F8) A PROPOSAL, in words: what changes (before → after), why, and the
 * two choices. Approving asks first ("This changes your plan"); the server
 * applies it through the app's own writer, so an approval keeps the app-wide
 * after-write refresh. A rejection changes nothing and refreshes only the
 * proposal lists. Shared by Ask (under the answer that made it) and Review ›
 * Suggestions. Ported from h2's `ask/ProposalCard.tsx`.
 */
export function ProposalCard({
  proposal,
  categories,
}: {
  proposal: AgentProposal;
  categories: ReadonlyMap<string, string>;
}) {
  const qc = useQueryClient();
  const approve = useApproveAgentProposal();
  const reject = useRejectAgentProposal({ mutation: { meta: OWN_INVALIDATION } });
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const change = describeChange(proposal, categories);
  const open = proposal.status === "proposed";
  const busy = approve.isPending || reject.isPending;
  const refresh = () => void qc.invalidateQueries({ queryKey: PROPOSALS_PREFIX });

  const doApprove = async () => {
    setConfirming(false);
    try {
      await approve.mutateAsync({ id: proposal.id });
      setNote({ text: "Applied.", error: false });
    } catch (e) {
      setNote({ text: decisionError(e, "apply"), error: true });
    }
    refresh();
  };
  const doReject = async () => {
    try {
      await reject.mutateAsync({ id: proposal.id });
      setNote({ text: "Rejected. Nothing changed.", error: false });
    } catch (e) {
      setNote({ text: decisionError(e, "reject"), error: true });
    }
    refresh();
  };

  return (
    <article
      className="flex flex-col gap-2 rounded-control bg-platinum-1 px-3 py-3 ring-1 ring-brand-line"
      data-testid="proposal-card"
      data-status={proposal.status}
      data-kind={proposal.kind}
    >
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="text-label font-semibold text-brand-navy">{KIND_WORD[proposal.kind]}</h3>
        <StatusChip tone={TONE[proposal.status]}>{PROPOSAL_STATUS_WORD[proposal.status]}</StatusChip>
      </div>
      <p className="text-body text-brand-ink" data-testid="proposal-change">
        <span>{change.what}: </span>
        <ChangeValue face={change.before} value={change.beforeValue} />
        <span> → </span>
        <ChangeValue face={change.after} value={change.afterValue} />
      </p>
      {change.txnId && (
        <Link
          href={refHref(change.txnId)}
          className="self-start text-micro font-semibold text-brand-navy underline-offset-2 hover:underline"
        >
          See the charge
        </Link>
      )}
      <details className="text-micro text-neutral-600">
        <summary className="cursor-pointer select-none font-semibold text-neutral-500 hover:text-brand-navy">
          Why H2 suggests this
        </summary>
        <p className="mt-1 text-body text-brand-ink" data-testid="proposal-rationale">
          {proposal.rationale}
        </p>
      </details>
      {open ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={btnSm}
            disabled={busy}
            onClick={() => setConfirming(true)}
            data-testid="proposal-approve"
          >
            Approve
          </button>
          <button
            type="button"
            className={btnSecondarySm}
            disabled={busy}
            onClick={() => void doReject()}
            data-testid="proposal-reject"
          >
            Reject
          </button>
          <span className="text-micro text-neutral-500">Expires {shortDateOfInstant(proposal.expiresAt)}</span>
        </div>
      ) : (
        proposal.decidedAt && (
          <p className="text-micro text-neutral-500">{shortDateOfInstant(proposal.decidedAt)}</p>
        )
      )}
      {note && (
        <p
          role={note.error ? "alert" : "status"}
          className={note.error ? "text-body text-bad" : "text-body text-neutral-600"}
          data-testid="proposal-note"
        >
          {note.text}
        </p>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent data-testid="proposal-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>This changes your plan</AlertDialogTitle>
            <AlertDialogDescription>
              {`${change.what}: ${change.before} to ${change.after}. H2 applies it now; you can change it back yourself.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not now</AlertDialogCancel>
            <button
              type="button"
              className={btn}
              onClick={() => void doApprove()}
              data-testid="proposal-confirm-approve"
            >
              Approve
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </article>
  );
}

function ChangeValue({ face, value }: { face: string; value: string | null }) {
  return value == null ? (
    <span>{face}</span>
  ) : (
    <data value={value} className="font-mono tabular-nums">
      {face}
    </data>
  );
}
