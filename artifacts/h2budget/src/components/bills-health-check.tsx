import { useMemo } from "react";
import type { BillsSummary } from "@workspace/api-client-react";
import { card, cardHead, Help, Stat, td } from "@/ui";

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
 *
 * ⭐ WHERE THE PARAGRAPHS WENT. This used to open with two sentences of prose
 * and repeat a third under every flagged row. The state is now a two-number
 * `Stat` row, each finding is a `.chip` whose LABEL says what is wrong, and the
 * sentence explaining the fix hangs off a `Help` chip one hover away. Nothing
 * was deleted — a check that hides what it is checking is worse than no check.
 */
export function BillsHealthCheck({ summary }: { summary: BillsSummary }) {
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
            title: `${item.name} + ${dm.debtName}`,
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
          title: `${dm.debtName} minimum`,
          detail:
            "Without a due day this minimum is forecast on the 1st of each month. Set its due day on the Debts page so it lands on the right date.",
        });
      }
    }

    return { issues: out, obligationCount: bills.length + debtMins.length };
  }, [summary]);

  const clean = issues.length === 0;

  return (
    <section className="space-y-3" data-testid="bills-health-check">
      <div className="flex items-center gap-2">
        <h2 className="text-label font-semibold text-brand-navy">Forecast health</h2>
        <Help>
          Audits what Bills sends to the cash forecast. It flags a recurring bill
          and a debt minimum that look like one obligation but aren't linked (so
          both hit the forecast), and a debt minimum with no due day (which gets
          forecast on the 1st).
        </Help>
      </div>

      <div className="flex flex-wrap gap-3">
        <Stat
          index={0}
          data-testid="stat-obligations"
          label="Obligations"
          value={obligationCount}
          hint="bills + minimums"
        />
        <Stat
          index={1}
          data-testid="stat-to-review"
          label="To review"
          value={issues.length}
          tone={clean ? "ok" : "bad"}
          hint={clean ? "none flagged" : "fix on Debts"}
        />
      </div>

      {/* Findings are never collapsed. A flagged double-count behind a chevron
          is the same as no check at all — the card only exists when there is
          something to read. */}
      {!clean && (
        <div className={card}>
          <div className={cardHead}>
            <h3 className="text-label font-semibold text-brand-navy">Findings</h3>
            <span className="ml-auto text-micro text-neutral-400">
              {issues.length} flagged
            </span>
          </div>
          <table className="w-full">
            <tbody>
              {issues.map((iss, i) => (
                <tr key={i} data-testid={`health-issue-${iss.kind}`}>
                  <td className={`${td} w-px whitespace-nowrap align-top`}>
                    <span
                      className={`chip ${iss.kind === "duplicate" ? "bad" : "warn"}`}
                    >
                      {iss.kind === "duplicate" ? "Double-count" : "No due date"}
                    </span>
                  </td>
                  <td className={td}>
                    <span className="flex items-center gap-1.5">
                      <span className="min-w-0 truncate">{iss.title}</span>
                      <Help>{iss.detail}</Help>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
