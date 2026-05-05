import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  type PlaidLiabilityAccount,
  useBulkCreateDebtsFromPlaidAccounts,
  getListDebtsQueryKey,
  getListPlaidLiabilityAccountsQueryKey,
  getGetBillsSummaryQueryKey,
  getGetForecastQueryKey,
  getGetDashboardQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type Candidate = {
  plaidAccountId: string;
  defaultName: string;
  institutionName: string | null;
  mask: string | null;
  balance: string | null;
  apr: string | null;
};

function buildDefaultName(a: PlaidLiabilityAccount): string {
  const suggestedName = a.suggestedDebt?.name?.trim();
  if (suggestedName) return suggestedName;
  const inst = a.institutionName?.trim() || a.name?.trim() || "Account";
  return a.mask ? `${inst} ••${a.mask}` : inst;
}

export function PostLinkDebtDialog({
  open,
  onOpenChange,
  accounts,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  accounts: PlaidLiabilityAccount[];
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const candidates = useMemo<Candidate[]>(
    () =>
      accounts.map((a) => ({
        plaidAccountId: a.id,
        defaultName: buildDefaultName(a),
        institutionName: a.institutionName ?? null,
        mask: a.mask ?? null,
        balance: a.suggestedDebt?.balance ?? a.balance ?? null,
        apr: a.suggestedDebt?.apr ?? a.apr ?? null,
      })),
    [accounts],
  );

  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [names, setNames] = useState<Record<string, string>>({});

  // Reset state when the candidate set changes (e.g., a new Link flow).
  useEffect(() => {
    if (!open) return;
    const sel: Record<string, boolean> = {};
    const nm: Record<string, string> = {};
    for (const c of candidates) {
      sel[c.plaidAccountId] = true;
      nm[c.plaidAccountId] = c.defaultName;
    }
    setSelected(sel);
    setNames(nm);
  }, [open, candidates]);

  const bulk = useBulkCreateDebtsFromPlaidAccounts();

  const selectedCount = candidates.filter(
    (c) => selected[c.plaidAccountId],
  ).length;

  const invalidateAfterChange = () => {
    qc.invalidateQueries({ queryKey: getListDebtsQueryKey() });
    qc.invalidateQueries({ queryKey: getListPlaidLiabilityAccountsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetBillsSummaryQueryKey() });
    qc.invalidateQueries({ queryKey: getGetForecastQueryKey() });
    qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
    qc.invalidateQueries({ queryKey: ["/api/amex/anchor"] });
  };

  const submit = async (mode: "selected" | "all") => {
    const picks = candidates.filter((c) =>
      mode === "all" ? true : selected[c.plaidAccountId],
    );
    if (picks.length === 0) {
      onOpenChange(false);
      return;
    }
    try {
      const res = await bulk.mutateAsync({
        data: {
          accounts: picks.map((c) => {
            const overridden = (names[c.plaidAccountId] ?? c.defaultName).trim();
            return {
              plaidAccountId: c.plaidAccountId,
              name: overridden && overridden !== c.defaultName ? overridden : null,
            };
          }),
        },
      });
      invalidateAfterChange();
      const created = res.results.filter((r) => r.status === "created");
      const linked = res.results.filter((r) => r.status === "linked-existing");
      const failed = res.results.filter(
        (r) => r.status === "error" || r.status === "not-found",
      );
      const summary: string[] = [];
      if (created.length > 0) summary.push(`Added ${created.length}`);
      if (linked.length > 0) summary.push(`linked ${linked.length} existing`);
      const debtNames = [...created, ...linked]
        .map((r) => r.debtName)
        .filter((n): n is string => !!n);
      toast({
        title:
          summary.length > 0
            ? summary.join(", ")
            : "No new debts were added",
        description: (
          <span>
            {debtNames.length > 0 && <>{debtNames.join(", ")}. </>}
            {failed.length > 0 && (
              <>
                {failed.length} could not be added.{" "}
              </>
            )}
            <Link
              to="/avalanche"
              className="underline font-medium"
              onClick={() => onOpenChange(false)}
            >
              View on Avalanche
            </Link>
          </span>
        ),
      });
      onOpenChange(false);
    } catch (err) {
      toast({
        title: "Could not add debts",
        description: String(err),
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg"
        data-testid="dialog-post-link-debts"
      >
        <DialogHeader>
          <DialogTitle>Add these as debts?</DialogTitle>
          <DialogDescription>
            We found {candidates.length}{" "}
            {candidates.length === 1 ? "credit/loan account" : "credit/loan accounts"}{" "}
            on this newly-linked bank that aren&apos;t debts yet. Add them to your
            payoff plan in one click — names are editable.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 max-h-80 overflow-y-auto">
          {candidates.map((c) => {
            const isOn = !!selected[c.plaidAccountId];
            return (
              <div
                key={c.plaidAccountId}
                className="flex items-start gap-3 rounded-md border p-3"
                data-testid={`row-post-link-${c.plaidAccountId}`}
              >
                <Checkbox
                  checked={isOn}
                  onCheckedChange={(v) =>
                    setSelected((prev) => ({
                      ...prev,
                      [c.plaidAccountId]: v === true,
                    }))
                  }
                  className="mt-2"
                  data-testid={`checkbox-post-link-${c.plaidAccountId}`}
                />
                <div className="flex-1 space-y-1">
                  <Label
                    htmlFor={`name-${c.plaidAccountId}`}
                    className="text-xs text-muted-foreground"
                  >
                    Name
                  </Label>
                  <Input
                    id={`name-${c.plaidAccountId}`}
                    value={names[c.plaidAccountId] ?? c.defaultName}
                    onChange={(e) =>
                      setNames((prev) => ({
                        ...prev,
                        [c.plaidAccountId]: e.target.value,
                      }))
                    }
                    disabled={!isOn}
                    data-testid={`input-post-link-name-${c.plaidAccountId}`}
                  />
                  <div className="text-xs text-muted-foreground flex gap-3 flex-wrap">
                    {c.mask && <span>••{c.mask}</span>}
                    {c.balance && (
                      <span>Balance: ${Number(c.balance).toFixed(2)}</span>
                    )}
                    {c.apr && (
                      <span>APR: {(Number(c.apr) * 100).toFixed(2)}%</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={bulk.isPending}
            data-testid="button-post-link-skip"
          >
            Not now
          </Button>
          <Button
            variant="outline"
            onClick={() => void submit("all")}
            disabled={bulk.isPending}
            data-testid="button-post-link-add-all"
          >
            {bulk.isPending && (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            )}
            Add all {candidates.length}
          </Button>
          <Button
            onClick={() => void submit("selected")}
            disabled={bulk.isPending || selectedCount === 0}
            data-testid="button-post-link-add-selected"
          >
            {bulk.isPending && (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            )}
            Add {selectedCount}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
