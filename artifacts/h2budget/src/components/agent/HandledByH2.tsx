import { useState } from "react";
import { useUndoAgentAction } from "@workspace/api-client-react/features";
import { Panel } from "@/components/next";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import { relativeTime } from "@/lib/dates";
import { OUTCOME, groupTrail, isStatus, type TrailGroup } from "@/lib/agentTrail";
import { btnLink, emptyNote } from "@/ui";
import { PayloadList } from "./PayloadList";
import { useAgentTrail, useOpenFindings, useRefreshAgent } from "./agentHooks";

/**
 * ⭐ "HANDLED BY H2" — the last ten things the agent did on its own, as short
 * lines. Why? opens what is known about the action (outcome, whether Undo is
 * available, and a finding's figures); Undo shows only while the action is
 * reversible and not yet undone. A 501 from the server (undo is not wired for
 * that action type yet) is a quiet notice, not an error. (F3)
 */
export function HandledByH2({ now }: { now?: Date }) {
  const trail = useAgentTrail();
  const findings = useOpenFindings();
  const undo = useUndoAgentAction();
  const refresh = useRefreshAgent();
  const [why, setWhy] = useState<TrailGroup | null>(null);

  const open = findings.data?.findings ?? [];
  const groups = groupTrail(trail.data?.actions ?? [], open);
  const whyFinding = why ? open.find((f) => why.actions.some((a) => a.targetId === f.id)) : undefined;

  const onUndo = async (g: TrailGroup) => {
    try {
      for (const a of g.undoable) await undo.mutateAsync({ id: a.id });
      refresh();
      toast({ title: "Undone." });
    } catch (e) {
      refresh();
      toast(
        isStatus(e, 501)
          ? { title: "Undo arrives with the next update." }
          : { title: "Couldn't undo that. Nothing more was changed.", variant: "destructive" },
      );
    }
  };

  const failed = !trail.data && trail.isError;
  const cold = !trail.data && !trail.isError;
  return (
    <>
      <Panel title="Handled by H2" sub="What it did on its own, most recent first" span={12} variant={["static", "flush"]} data-testid="trail">
        {cold ? (
          <p className={emptyNote} aria-busy="true">
            Loading…
          </p>
        ) : failed ? (
          <p className="p-4 text-body text-bad" role="alert" data-testid="trail-failed">
            Couldn't load what H2 handled.{" "}
            <button type="button" className={btnLink} onClick={() => void trail.refetch()}>
              Try again
            </button>
          </p>
        ) : groups.length === 0 ? (
          <p className={emptyNote} data-testid="trail-empty">
            H2 hasn't handled anything on its own yet.
          </p>
        ) : (
          <ul className="list-none p-0" data-testid="trail-items">
            {groups.map((g) => (
              <li
                key={g.key}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-brand-line px-4 py-2 first:border-t-0"
                data-testid="trail-item"
              >
                <span className="min-w-0">
                  <span className="text-body text-brand-navy">{g.title}</span>
                  <span className="ml-2 text-micro text-neutral-500">{relativeTime(g.at, now)}</span>
                  {g.undone && <span className="chip gray ml-2">Undone</span>}
                </span>
                <span className="flex items-center gap-2">
                  <button type="button" className={btnLink} onClick={() => setWhy(g)}>
                    Why?
                  </button>
                  {g.undoable.length > 0 && (
                    <button type="button" className={btnLink} onClick={() => void onUndo(g)} disabled={undo.isPending} data-testid="trail-undo">
                      Undo
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Dialog open={why != null} onOpenChange={(o) => !o && setWhy(null)}>
        <DialogContent>
          {why && (
            <>
              <DialogHeader>
                <DialogTitle>{why.title}</DialogTitle>
                <DialogDescription>{relativeTime(why.at, now)}</DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-4" data-testid="why-sheet">
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-body">
                  <dt className="text-neutral-600">Outcome</dt>
                  <dd className="text-brand-navy">{OUTCOME[why.actions[0]!.outcome]}</dd>
                  <dt className="text-neutral-600">Undo</dt>
                  <dd className="text-brand-navy">{why.undone ? "Already undone" : why.undoable.length > 0 ? "Available" : "Not available for this"}</dd>
                  <dt className="text-neutral-600">Items</dt>
                  <dd className="font-mono tabular-nums text-brand-navy">{why.actions.length}</dd>
                </dl>
                {whyFinding ? (
                  <PayloadList payload={whyFinding.payload} />
                ) : (
                  <p className="text-body text-neutral-600">H2 did this on its own, from what you have already told it.</p>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
