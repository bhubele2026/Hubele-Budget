import { useState } from "react";
import { Link } from "wouter";
import { ChevronDown } from "lucide-react";
import { useDismissAgentFinding, useUndoAgentAction, type AgentFinding } from "@workspace/api-client-react";
import { useInvalidateActivity, useAgentFindings, useAgentTrail } from "@/data/activityData";
import { Button, buttonClass } from "@/kit/Button";
import { Note } from "@/kit/Note";
import { Section } from "@/kit/Section";
import { Sheet } from "@/kit/Sheet";
import { StatusWord } from "@/kit/StatusWord";
import { TrailItem } from "@/kit/TrailItem";
import { useToast } from "@/kit/Toast";
import { relativeTime } from "@/lib/dates";
import { fmtMoney } from "@/lib/money";
import { FINDING_TITLE, groupTrail, payloadLines, type TrailGroup } from "./trailWords";
import { isStatus } from "./words";

const OUTCOME = {
  applied: "Done",
  proposed: "Suggested, waiting for you",
  needs_attention: "Needs you",
} as const;

function PayloadList({ payload }: { payload: Record<string, unknown> }) {
  const lines = payloadLines(payload);
  if (lines.length === 0) return <p className="type-body text-ink-2">No figures came with this one.</p>;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 type-body" data-testid="why-figures">
      {lines.map((l) => (
        <div key={l.label} className="contents">
          <dt className="text-ink-2">{l.label}</dt>
          <dd className="text-ink">
            {typeof l.value === "number" ? (
              <span className="tnum">{l.money ? fmtMoney(l.value) : l.value}</span>
            ) : (
              l.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** "Needs attention": the monitor's open findings, short, each dismissable. */
function Findings({ findings }: { findings: AgentFinding[] }) {
  const toast = useToast();
  const dismiss = useDismissAgentFinding();
  const refresh = useInvalidateActivity();
  const [why, setWhy] = useState<AgentFinding | null>(null);
  if (findings.length === 0) return null;
  const onDismiss = async (f: AgentFinding) => {
    try {
      await dismiss.mutateAsync({ id: f.id });
      refresh();
    } catch {
      toast.show({ message: "Couldn't dismiss that. It's still here.", tone: "error" });
    }
  };
  return (
    <Section label="Needs attention" data-testid="findings">
      <ul>
        {findings.map((f) => (
          <li
            key={f.id}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-rule py-2 first:border-t-0"
            data-testid="finding"
          >
            <span className="min-w-0">
              <span className="type-body text-ink">{FINDING_TITLE[f.kind] ?? "Something to look at"}</span>
              <span className="ml-2 inline-flex">
                <StatusWord tone={f.severity === "high" ? "over" : f.severity === "watch" ? "tight" : "neutral"}>
                  {f.severity === "high" ? "Important" : f.severity === "watch" ? "Watch" : "Note"}
                  {f.confidence === "estimate" ? " · estimate" : ""}
                </StatusWord>
              </span>
            </span>
            <span className="flex items-center gap-3">
              {f.kind === "shortfall_before_income" && (
                <Link href="/" className={buttonClass({ variant: "link", size: "sm" })}>
                  See Today
                </Link>
              )}
              <Button variant="link" size="sm" onClick={() => setWhy(f)}>
                Why?
              </Button>
              <Button variant="link" size="sm" onClick={() => onDismiss(f)} disabled={dismiss.isPending}>
                Dismiss
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {why && (
        <Sheet
          open
          onOpenChange={(o) => !o && setWhy(null)}
          title={FINDING_TITLE[why.kind] ?? "Something to look at"}
          description={`First seen ${relativeTime(why.firstSeen)}`}
        >
          <PayloadList payload={why.payload} />
        </Sheet>
      )}
    </Section>
  );
}

/**
 * ⭐ "HANDLED BY H2" — the last ten things the agent did on its own, as short
 * lines. Why? opens what is known about the action; Undo shows only while the
 * action is reversible and not yet undone. A 501 from the server (the undo is
 * not wired for that action yet) is a quiet notice, not an error.
 */
export function AgentTrail({ now }: { now?: Date }) {
  const trail = useAgentTrail();
  const findings = useAgentFindings();
  const toast = useToast();
  const undo = useUndoAgentAction();
  const refresh = useInvalidateActivity();
  const [why, setWhy] = useState<TrailGroup | null>(null);

  const open = findings.data?.findings ?? [];
  const groups = groupTrail(trail.data?.actions ?? [], open);

  const onUndo = async (g: TrailGroup) => {
    try {
      for (const a of g.undoable) await undo.mutateAsync({ id: a.id });
      refresh();
      toast.show({ message: "Undone." });
    } catch (e) {
      refresh();
      toast.show(
        isStatus(e, 501)
          ? { message: "Undo arrives with the next update." }
          : { message: "Couldn't undo that. Nothing more was changed.", tone: "error" },
      );
    }
  };

  const whyFinding = why ? open.find((f) => why.actions.some((a) => a.targetId === f.id)) : undefined;

  return (
    <>
      <Findings findings={open} />
      {trail.state === "failed" && (
        <div className="pb-6">
          <Note kind="error" onRetry={trail.refetch} retrying={trail.isFetching}>
            Couldn't load what H2 handled.
          </Note>
        </div>
      )}
      {groups.length > 0 && (
        <details className="group mb-6 border-t border-rule py-4" data-testid="trail">
          <summary className="flex cursor-pointer list-none items-baseline justify-between gap-4 [&::-webkit-details-marker]:hidden">
            <span className="type-section text-ink-2">Handled by H2</span>
            <span className="flex items-center gap-2 type-caption text-ink-3">
              {groups[0]!.title}
              <ChevronDown size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-ink-2 group-open:rotate-180" />
            </span>
          </summary>
          <ul className="mt-3" data-testid="trail-items">
            {groups.map((g) => (
              <TrailItem
                key={g.key}
                title={g.title}
                when={relativeTime(g.at, now)}
                undone={g.undone}
                controls={
                  <>
                    <Button variant="link" size="sm" onClick={() => setWhy(g)}>
                      Why?
                    </Button>
                    {g.undoable.length > 0 && (
                      <Button variant="link" size="sm" onClick={() => onUndo(g)} disabled={undo.isPending} data-testid="trail-undo">
                        Undo
                      </Button>
                    )}
                  </>
                }
              />
            ))}
          </ul>
        </details>
      )}
      {why && (
        <Sheet open onOpenChange={(o) => !o && setWhy(null)} title={why.title} description={relativeTime(why.at, now)}>
          <div className="flex flex-col gap-4" data-testid="why-sheet">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 type-body">
              <dt className="text-ink-2">Outcome</dt>
              <dd className="text-ink">{OUTCOME[why.actions[0]!.outcome]}</dd>
              <dt className="text-ink-2">Undo</dt>
              <dd className="text-ink">{why.undone ? "Already undone" : why.undoable.length > 0 ? "Available" : "Not available for this"}</dd>
              <dt className="text-ink-2">Items</dt>
              <dd className="text-ink tnum">{why.actions.length}</dd>
            </dl>
            {whyFinding ? (
              <PayloadList payload={whyFinding.payload} />
            ) : (
              <p className="type-body text-ink-2">H2 did this on its own, from what you have already told it.</p>
            )}
          </div>
        </Sheet>
      )}
    </>
  );
}
