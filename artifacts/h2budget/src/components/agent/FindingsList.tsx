import { useState } from "react";
import { Link } from "wouter";
import { useDismissAgentFinding, useResolveAgentFinding, type AgentFinding } from "@workspace/api-client-react/features";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import { relativeTime } from "@/lib/dates";
import { FINDING_LINK, FINDING_TITLE, SEVERITY_WORD } from "@/lib/agentTrail";
import { btnLink } from "@/ui";
import { OWN_INVALIDATION } from "@/lib/mutationInvalidation";
import { PayloadList } from "./PayloadList";
import { useRefreshAgent } from "./agentHooks";

/**
 * "Needs attention": the monitor's open findings, short. Why? shows the
 * figures it saw; Resolve says it is handled (it will not re-fire for 7 days
 * unless it gets more severe); Dismiss takes it off the list (it stays in the
 * ledger). (F3; ported from h2's `AgentTrail.tsx` Findings, plus Resolve.)
 */
export function FindingsList({ findings }: { findings: readonly AgentFinding[] }) {
  const dismiss = useDismissAgentFinding({ mutation: { meta: OWN_INVALIDATION } });
  const resolve = useResolveAgentFinding({ mutation: { meta: OWN_INVALIDATION } });
  const refresh = useRefreshAgent();
  const [why, setWhy] = useState<AgentFinding | null>(null);
  const busy = dismiss.isPending || resolve.isPending;

  const settle = async (f: AgentFinding, kind: "dismiss" | "resolve") => {
    try {
      if (kind === "dismiss") await dismiss.mutateAsync({ id: f.id });
      else await resolve.mutateAsync({ id: f.id });
      refresh();
    } catch {
      toast({ title: `Couldn't ${kind} that. It's still here.`, variant: "destructive" });
    }
  };

  return (
    <>
      <ul className="list-none p-0" data-testid="findings">
        {findings.map((f) => {
          const link = FINDING_LINK[f.kind];
          const tone = f.severity === "high" ? "bad" : f.severity === "watch" ? "warn" : "gray";
          return (
            <li
              key={f.id}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-brand-line py-2 first:border-t-0"
              data-testid="finding"
            >
              <span className="min-w-0">
                <span className="text-body text-brand-navy">{FINDING_TITLE[f.kind] ?? "Something to look at"}</span>
                <span className={`chip ${tone} ml-2`} data-testid="finding-severity">
                  {SEVERITY_WORD[f.severity]}
                  {f.confidence === "estimate" ? " · estimate" : ""}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-2">
                {link && (
                  <Link href={link.href} className={btnLink}>
                    {link.label}
                  </Link>
                )}
                <button type="button" className={btnLink} onClick={() => setWhy(f)}>
                  Why?
                </button>
                <button type="button" className={btnLink} onClick={() => void settle(f, "resolve")} disabled={busy} data-testid="finding-resolve">
                  Resolve
                </button>
                <button type="button" className={btnLink} onClick={() => void settle(f, "dismiss")} disabled={busy} data-testid="finding-dismiss">
                  Dismiss
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      <Dialog open={why != null} onOpenChange={(o) => !o && setWhy(null)}>
        <DialogContent>
          {why && (
            <>
              <DialogHeader>
                <DialogTitle>{FINDING_TITLE[why.kind] ?? "Something to look at"}</DialogTitle>
                <DialogDescription>First seen {relativeTime(why.firstSeen)}</DialogDescription>
              </DialogHeader>
              <PayloadList payload={why.payload} />
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
