import { useState } from "react";
import {
  useGetMe,
  useRunPlaidMalformedTokenSweep,
  type PlaidMalformedTokenSweepResult,
} from "@workspace/api-client-react";
import { Panel } from "@/components/next";
import { useToast } from "@/hooks/use-toast";
import { btnSecondary, fieldLabel, Help } from "@/ui";
import { RefreshCw } from "lucide-react";

const SAMPLE_LIMIT = 5;

function describeAlert(
  alert: PlaidMalformedTokenSweepResult["alert"],
): string {
  if (!alert) {
    return "Alert evaluator threw — sweep counts above are still authoritative.";
  }
  if (alert.channel === "skipped") {
    const reason = alert.reason ?? "no reason given";
    return `No alert dispatched (skipped: ${reason}).`;
  }
  const recipient = alert.recipient ?? "operator";
  if (alert.error) {
    return `Tried to dispatch via ${alert.channel} to ${recipient} but failed: ${alert.error}`;
  }
  return `Alert dispatched via ${alert.channel} to ${recipient}.`;
}

export function OwnerBankHealthSweepSection() {
  const { data: me, isLoading: meLoading } = useGetMe();
  const isOwner = me?.isOwner === true;
  const { toast } = useToast();
  const [result, setResult] = useState<PlaidMalformedTokenSweepResult | null>(
    null,
  );
  const [ranAt, setRanAt] = useState<number | null>(null);
  const runSweep = useRunPlaidMalformedTokenSweep({
    mutation: {
      onSuccess: (data) => {
        setResult(data);
        setRanAt(Date.now());
        toast({
          title: "Bank-login health check complete",
          description: `Scanned ${data.scanned} item${data.scanned === 1 ? "" : "s"}, flagged ${data.flagged}.`,
        });
      },
      onError: (err) => {
        toast({
          title: "Bank-login health check failed",
          description: String(err),
          variant: "destructive",
        });
      },
    },
  });

  if (meLoading) return null;
  if (!isOwner) return null;

  const sample = result?.flaggedItems.slice(0, SAMPLE_LIMIT) ?? [];
  const overflow = result ? Math.max(0, result.flaggedItems.length - SAMPLE_LIMIT) : 0;

  // (C8) A Settings › Banks panel on the h2budget kit; test ids unchanged.
  return (
    <Panel
      title="Bank-login health check"
      sub="Owner only"
      span={12}
      variant="static"
      data-testid="card-owner-bank-health-sweep"
      actions={
        <Help>
          Re-runs the same daily malformed-access-token sweep that runs
          unattended at 03:02 UTC. Use it after investigating a spike alert to
          confirm the fix now instead of waiting for tomorrow morning.
        </Help>
      }
    >
      <div className="space-y-4">
        <button
          type="button"
          className={btnSecondary}
          onClick={() => runSweep.mutate()}
          disabled={runSweep.isPending}
          data-testid="button-run-bank-health-sweep"
        >
          <RefreshCw
            className={`mr-1.5 inline h-4 w-4 align-[-3px] ${runSweep.isPending ? "animate-spin" : ""}`}
          />
          {runSweep.isPending ? "Running…" : "Run health check now"}
        </button>

        {result && (
          <div
            className="section-enter space-y-3 rounded-control bg-platinum-2 p-3 text-body ring-1 ring-brand-line"
            data-testid="bank-health-sweep-result"
          >
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              <div>
                <span className="text-neutral-500">Scanned: </span>
                <span className="font-mono font-semibold tabular-nums text-brand-navy" data-testid="text-sweep-scanned">
                  {result.scanned}
                </span>
              </div>
              <div>
                <span className="text-neutral-500">Flagged: </span>
                <span className="font-mono font-semibold tabular-nums text-brand-navy" data-testid="text-sweep-flagged">
                  {result.flagged}
                </span>
              </div>
              {ranAt && (
                <div className="text-neutral-500">Ran {new Date(ranAt).toLocaleTimeString()}</div>
              )}
            </div>

            <div>
              <h4 className={`mb-1 ${fieldLabel}`}>Flagged institutions</h4>
              {result.flaggedItems.length === 0 ? (
                <p className="text-neutral-500" data-testid="text-sweep-no-flagged">
                  None — all access tokens look well-formed.
                </p>
              ) : (
                <ul className="list-disc space-y-0.5 pl-5" data-testid="list-sweep-flagged-items">
                  {sample.map((item) => (
                    <li key={item.itemRowId} data-testid={`row-sweep-flagged-${item.itemRowId}`}>
                      <span className="font-medium text-brand-navy">
                        {item.institutionName ?? "Unknown bank"}
                      </span>
                      <span className="text-neutral-500"> — item {item.itemId}</span>
                    </li>
                  ))}
                  {overflow > 0 && (
                    <li className="text-neutral-500" data-testid="text-sweep-overflow">
                      …and {overflow} more
                    </li>
                  )}
                </ul>
              )}
            </div>

            <div>
              <h4 className={`mb-1 ${fieldLabel}`}>Spike alert</h4>
              <p className="text-neutral-500" data-testid="text-sweep-alert">
                {describeAlert(result.alert)}
              </p>
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}
