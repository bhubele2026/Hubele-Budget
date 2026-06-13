import { useMemo, useState } from "react";
import {
  ChevronDown,
  AlertTriangle,
  CheckCircle2,
  CalendarX,
} from "lucide-react";
import type { BillsSummary } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// Sentinel debtId for the synthetic "Avalanche extra payment" row — it's not a
// real obligation to dedup against, so we exclude it from the checks.
const AVALANCHE_EXTRA_DEBT_ID = "avalanche-extra";

// Normalize a payee name for fuzzy comparison: lowercase, drop the
// minimum/payment filler words, strip everything non-alphanumeric. Keeps the
// distinguishing parts (e.g. "Amex Loan") so we don't over-match.
function norm(s: string | null | undefined): string {
  return (s || "")
    .toLowerCase()
    .replace(/\b(minimum|min|payment|pmt|autopay|auto pay|bill)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

type Issue = {
  kind: "duplicate" | "no-date";
  title: string;
  detail: string;
};

/**
 * Read-only audit of everything that feeds the cash forecast from Bills:
 * recurring bills + debt minimums. Flags the two real failure modes —
 * a bill and a debt minimum that look like the same obligation but aren't
 * linked (so both hit the forecast), and a debt minimum with no due date
 * (which gets forecast on the 1st). Pure client-side over the Bills summary;
 * no new endpoint.
 */
export function BillsHealthCheck({ summary }: { summary: BillsSummary }) {
  const [open, setOpen] = useState(true);

  const { issues, obligationCount } = useMemo(() => {
    const out: Issue[] = [];
    const bills = summary.bills ?? [];
    const debtMins = (summary.debtMins ?? []).filter(
      (d) => d.debtId !== AVALANCHE_EXTRA_DEBT_ID,
    );

    // [1] Likely double-count — a recurring bill whose name matches a debt
    //    minimum it is NOT linked to. (Linked recurring items are already
    //    suppressed from `bills` server-side, so these are the unlinked
    //    collisions that genuinely double up in the forecast.)
    const seenDup = new Set<string>();
    for (const dm of debtMins) {
      const dmNorm = norm(dm.debtName);
      if (!dmNorm) continue;
      for (const b of bills) {
        const item = b.item;
        if (!item) continue;
        if (item.debtId && item.debtId === dm.debtId) continue; // properly linked
        if (item.id === dm.linkedRecurringId) continue;
        const bNorm = norm(item.name);
        if (!bNorm) continue;
        if (bNorm === dmNorm || bNorm.includes(dmNorm) || dmNorm.includes(bNorm)) {
          const key = `${item.id}|${dm.debtId}`;
          if (seenDup.has(key)) continue;
          seenDup.add(key);
          out.push({
            kind: "duplicate",
            title: `Possible double-count: "${item.name}" + "${dm.debtName}"`,
            detail:
              "A recurring bill and a debt minimum look like the same obligation but aren't linked — both hit your forecast. Link the bill to the debt (on the Debts page) or delete one so it only counts once.",
          });
        }
      }
    }

    // [2] Missing due date — an unlinked debt minimum with no due day gets
    //    forecast on the 1st of each month, which can mis-time cash dips.
    for (const dm of debtMins) {
      if (dm.endsThisCycle) continue; // paid off
      if (dm.linkedRecurringId) continue; // dated by the linked bill
      if (dm.dueDay == null) {
        out.push({
          kind: "no-date",
          title: `"${dm.debtName}" has no due date`,
          detail:
            "Without a due day this minimum is forecast on the 1st of each month. Set its due day on the Debts page so it lands on the right date.",
        });
      }
    }

    return { issues: out, obligationCount: bills.length + debtMins.length };
  }, [summary]);

  const clean = issues.length === 0;

  return (
    <Card data-testid="bills-health-check">
      <CardContent className="p-4">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="w-full flex items-center gap-2 text-left"
          aria-expanded={open}
        >
          {clean ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          ) : (
            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
          )}
          <span className="text-sm font-semibold flex-1">
            Forecast health check
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {obligationCount} obligation{obligationCount === 1 ? "" : "s"} ·{" "}
              {clean ? "all clear" : `${issues.length} to review`}
            </span>
          </span>
          <ChevronDown
            className={cn(
              "w-4 h-4 text-muted-foreground transition-transform",
              !open && "-rotate-90",
            )}
          />
        </button>

        {open && (
          <div className="mt-3 space-y-2">
            {clean ? (
              <p className="text-sm text-muted-foreground">
                Every bill and minimum payment feeds the forecast exactly once,
                with a real due date. Nothing looks doubled or mis-dated. ✅
              </p>
            ) : (
              issues.map((iss, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2 rounded-md border border-amber-400/50 bg-amber-50 dark:bg-amber-950/30 px-3 py-2"
                  data-testid={`health-issue-${iss.kind}`}
                >
                  {iss.kind === "duplicate" ? (
                    <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                  ) : (
                    <CalendarX className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{iss.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {iss.detail}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
