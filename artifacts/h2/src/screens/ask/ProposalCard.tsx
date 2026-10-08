import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useApproveAgentProposal, useRejectAgentProposal, type AgentProposal } from "@workspace/api-client-react";
import { Button } from "@/kit/Button";
import { Disclosure } from "@/kit/Disclosure";
import { Sheet } from "@/kit/Sheet";
import { StatusWord, type StatusTone } from "@/kit/StatusWord";
import { shortDateOfInstant } from "@/lib/dates";
import { apiMessage } from "@/screens/household/words";
import { PROPOSALS_PREFIX } from "./askData";
import { describeChange, KIND_WORD, PROPOSAL_STATUS_WORD, refHref } from "./askWords";

const TONE: Record<AgentProposal["status"], StatusTone> = {
  proposed: "tight",
  approved: "fresh",
  applied: "fresh",
  rejected: "stale",
  expired: "stale",
};

/** The server's reason for each refusal, in its own words where it sends them. */
function decisionError(e: unknown, verb: "apply" | "reject"): string {
  const status = (e as { status?: number } | null)?.status;
  if (status === 409) return "This is no longer open, or what it changes has moved. Nothing changed.";
  if (status === 404) return "H2 could not find this proposal. Nothing changed.";
  return apiMessage(e, `Couldn't ${verb} that. Nothing changed.`);
}

/**
 * ⭐ A PROPOSAL, in words: what changes (before → after), why, and the two
 * choices. Approving asks first ("This changes your plan"); the server applies
 * it through the app's own writer and H2 shows what it answered. Shared by
 * /ask (under the answer that made it) and /plan/proposals.
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
  const reject = useRejectAgentProposal();
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
    <article className="flex flex-col gap-2 border-t border-rule py-4" data-testid="proposal-card" data-status={proposal.status} data-kind={proposal.kind}>
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="type-label text-ink-2">{KIND_WORD[proposal.kind]}</h3>
        <StatusWord tone={TONE[proposal.status]}>{PROPOSAL_STATUS_WORD[proposal.status]}</StatusWord>
      </div>
      <p className="type-body text-ink" data-testid="proposal-change">
        <span>{change.what}: </span>
        <ChangeValue face={change.before} value={change.beforeValue} />
        <span> → </span>
        <ChangeValue face={change.after} value={change.afterValue} />
      </p>
      {change.txnId && (
        <Link href={refHref(change.txnId)} className="self-start type-label text-moss underline decoration-1 underline-offset-4 hover:text-moss-ink">
          See the charge
        </Link>
      )}
      <Disclosure summary="Why H2 suggests this">
        <p data-testid="proposal-rationale">{proposal.rationale}</p>
      </Disclosure>
      {open ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" size="sm" disabled={busy} onClick={() => setConfirming(true)} data-testid="proposal-approve">
            Approve
          </Button>
          <Button variant="quiet" size="sm" disabled={busy} onClick={doReject} data-testid="proposal-reject">
            Reject
          </Button>
          <span className="type-caption text-ink-3">Expires {shortDateOfInstant(proposal.expiresAt)}</span>
        </div>
      ) : (
        proposal.decidedAt && <p className="type-caption text-ink-3">{shortDateOfInstant(proposal.decidedAt)}</p>
      )}
      {note && (
        <p role={note.error ? "alert" : "status"} className={note.error ? "type-body text-clay" : "type-body text-ink-2"} data-testid="proposal-note">
          {note.text}
        </p>
      )}
      <Sheet open={confirming} onOpenChange={setConfirming} title="This changes your plan" description={`${change.what}: ${change.before} to ${change.after}`}>
        <div className="flex flex-col gap-4" data-testid="proposal-confirm">
          <p className="type-body text-ink-2">H2 applies it now. You can change it back in Plan.</p>
          <div className="flex gap-3">
            <Button variant="primary" onClick={doApprove} data-testid="proposal-confirm-approve">
              Approve
            </Button>
            <Button variant="quiet" onClick={() => setConfirming(false)}>
              Not now
            </Button>
          </div>
        </div>
      </Sheet>
    </article>
  );
}

function ChangeValue({ face, value }: { face: string; value: string | null }) {
  return value == null ? (
    <span>{face}</span>
  ) : (
    <data value={value} className="tnum font-mono">
      {face}
    </data>
  );
}
