import { useState } from "react";
import {
  useGetMe,
  useRunPlaidMalformedTokenSweep,
  type PlaidMalformedTokenSweepResult,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { ShieldCheck, RefreshCw } from "lucide-react";

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

  return (
    <Card data-testid="card-owner-bank-health-sweep">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5" />
          Bank-login health check
        </CardTitle>
        <CardDescription>
          Re-runs the same daily malformed-access-token sweep that runs
          unattended at 03:02 UTC. Use this after investigating a spike
          alert to confirm the fix immediately instead of waiting for
          tomorrow morning.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Button
            type="button"
            onClick={() => runSweep.mutate()}
            disabled={runSweep.isPending}
            data-testid="button-run-bank-health-sweep"
          >
            <RefreshCw
              className={`w-4 h-4 mr-2 ${runSweep.isPending ? "animate-spin" : ""}`}
            />
            {runSweep.isPending ? "Running…" : "Run health check now"}
          </Button>
        </div>

        {result && (
          <div
            className="rounded-md border border-border p-3 space-y-3 text-sm"
            data-testid="bank-health-sweep-result"
          >
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              <div>
                <span className="text-muted-foreground">Scanned: </span>
                <span
                  className="font-semibold"
                  data-testid="text-sweep-scanned"
                >
                  {result.scanned}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Flagged: </span>
                <span
                  className="font-semibold"
                  data-testid="text-sweep-flagged"
                >
                  {result.flagged}
                </span>
              </div>
              {ranAt && (
                <div className="text-muted-foreground">
                  Ran {new Date(ranAt).toLocaleTimeString()}
                </div>
              )}
            </div>

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                Flagged institutions
              </h4>
              {result.flaggedItems.length === 0 ? (
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="text-sweep-no-flagged"
                >
                  None — all access tokens look well-formed.
                </p>
              ) : (
                <ul
                  className="list-disc pl-5 space-y-0.5"
                  data-testid="list-sweep-flagged-items"
                >
                  {sample.map((item) => (
                    <li
                      key={item.itemRowId}
                      data-testid={`row-sweep-flagged-${item.itemRowId}`}
                    >
                      <span className="font-medium">
                        {item.institutionName ?? "Unknown bank"}
                      </span>
                      <span className="text-muted-foreground">
                        {" "}
                        — item {item.itemId}
                      </span>
                    </li>
                  ))}
                  {overflow > 0 && (
                    <li
                      className="text-muted-foreground"
                      data-testid="text-sweep-overflow"
                    >
                      …and {overflow} more
                    </li>
                  )}
                </ul>
              )}
            </div>

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                Spike alert
              </h4>
              <p
                className="text-sm text-muted-foreground"
                data-testid="text-sweep-alert"
              >
                {describeAlert(result.alert)}
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
