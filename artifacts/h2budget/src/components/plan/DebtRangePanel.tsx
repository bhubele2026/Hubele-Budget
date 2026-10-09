import { useGetDebtPlan, type DebtPlan } from "@workspace/api-client-react";
import { Panel } from "@/components/next";
import { Help, emptyNote, fieldLabel } from "@/ui";
import { shortDate } from "@/lib/dates";
import { centsValue, fmtMoney, toAmount } from "@/lib/money";
import { monthWords } from "@/lib/planWords";

function Money({ value }: { value: string | number | null | undefined }) {
  const n = toAmount(value);
  if (n == null) return <span className="text-neutral-400">—</span>;
  return (
    <data value={centsValue(n)} className="font-mono tabular-nums">
      {fmtMoney(n)}
    </data>
  );
}

function Comparison({ plan, chosen }: { plan: DebtPlan; chosen: "avalanche" | "snowball" }) {
  const name = (id: string) => plan.comparison.detail.debts.find((d) => d.debtId === id)?.name ?? "A debt";
  const cols = [
    { key: "avalanche" as const, label: "Avalanche", s: plan.comparison.avalanche },
    { key: "snowball" as const, label: "Snowball", s: plan.comparison.snowball },
  ];
  const rows: Array<[string, (s: (typeof cols)[number]["s"]) => React.ReactNode]> = [
    ["Months to go", (s) => (s.monthsToFreedom == null ? "—" : s.monthsToFreedom)],
    ["Debt-free around", (s) => (s.debtFreeMonth ? monthWords(s.debtFreeMonth) : "—")],
    ["Projected interest", (s) => (s.totalInterest == null ? "—" : <Money value={s.totalInterest} />)],
    ["First one cleared", (s) => (s.firstKill ? `${name(s.firstKill.debtId)}, ${monthWords(s.firstKill.month)}` : "—")],
  ];
  return (
    <table className="w-full border-collapse text-body" data-testid="comparison">
      <caption className="sr-only">Avalanche and snowball side by side</caption>
      <thead>
        <tr>
          <th scope="col" className="py-1.5 pr-2 text-left">
            <span className="sr-only">Measure</span>
          </th>
          {cols.map((c) => (
            <th key={c.key} scope="col" className="py-1.5 pl-2 text-right text-label font-semibold text-brand-navy" aria-current={c.key === chosen ? "true" : undefined}>
              {c.label}
              {c.key === chosen && <span className="block text-micro font-normal text-neutral-500">your plan</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, cell]) => (
          <tr key={label} className="border-t border-brand-line">
            <th scope="row" className="py-1.5 pr-2 text-left text-body font-normal text-neutral-600">
              {label}
            </th>
            {cols.map((c) => (
              <td key={c.key} className="py-1.5 pl-2 text-right font-mono tabular-nums text-brand-navy">
                {cell(c.s)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * ⭐ WHEN IT ENDS (F11) — the server's debt plan as a RANGE: "Debt-free around
 * Mar 2028 to Aug 2028", the projected interest range, avalanche against
 * snowball, and the milestones. Read-only: strategy and extra are set above.
 *
 * ⚠️ NO ONE DATE. This panel never says "debt-free on <day>", and never shows
 * a balance (the plan's per-debt detail carries them and is not shown here).
 */
export function DebtRangePanel() {
  const q = useGetDebtPlan({ query: { staleTime: 5 * 60_000, gcTime: 30 * 60_000 } as never });
  const p = q.data as DebtPlan | undefined;
  const range = p?.range;

  return (
    <Panel
      title="When it ends"
      sub="The server's plan, as a range"
      span={12}
      variant="static"
      data-testid="debt-range"
      actions={<Help>A range, never one date: it runs the plan three ways (as is, with half the extra, and with new charges) and shows the earliest and the latest.</Help>}
    >
      {!p ? (
        <div className={emptyNote} aria-busy={q.isLoading}>
          {q.isError ? (
            <>
              Couldn't load the debt plan.{" "}
              <button type="button" className="underline" onClick={() => void q.refetch()}>
                Try again
              </button>
            </>
          ) : (
            "Loading…"
          )}
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <section data-testid="range-section">
            <div className={fieldLabel}>Debt-free</div>
            {!range || range.earliestMonth == null ? (
              <p className="mt-1 text-body text-neutral-500">Not enough on file to project a finish yet.</p>
            ) : (
              <>
                <p className="mt-1 font-mono text-title font-semibold text-brand-navy" data-testid="range-line">
                  Debt-free around {monthWords(range.earliestMonth)}
                  {range.latestMonth ? ` to ${monthWords(range.latestMonth)}` : " or later"}
                </p>
                {range.interestLow != null && range.interestHigh != null && (
                  <p className="mt-1 text-body text-neutral-600" data-testid="interest-range">
                    Projected interest <Money value={range.interestLow} />
                    {" to "}
                    <Money value={range.interestHigh} />
                  </p>
                )}
                {range.assumptions.length > 0 && (
                  <details className="mt-3 text-micro text-neutral-500" data-testid="assumptions">
                    <summary className="cursor-pointer font-semibold">What this assumes</summary>
                    <ul className="mt-1 flex flex-col gap-1">
                      {range.assumptions.map((a) => (
                        <li key={a.key}>{a.text}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            )}
          </section>

          <section data-testid="comparison-section">
            <div className={fieldLabel}>Avalanche or snowball</div>
            <div className="mt-1">
              <Comparison plan={p} chosen={p.strategy === "snowball" ? "snowball" : "avalanche"} />
            </div>
          </section>

          <section data-testid="milestones-section">
            <div className={fieldLabel}>Milestones</div>
            {p.milestones.achieved.length === 0 && !p.milestones.next ? (
              <p className="mt-1 text-body text-neutral-500">Milestones show up here as you pay down.</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-2 text-body">
                {p.milestones.achieved.map((m) => (
                  <li key={m.key} className="flex items-baseline justify-between gap-4" data-testid="milestone-achieved">
                    <span className="text-brand-navy">{m.label}</span>
                    <span className="text-micro text-neutral-500">reached {shortDate(m.achievedOn)}</span>
                  </li>
                ))}
                {p.milestones.next && (
                  <li className="flex items-baseline justify-between gap-4" data-testid="milestone-next">
                    <span className="text-brand-navy">Next: {p.milestones.next.label}</span>
                    <span className="text-micro text-neutral-500">around {monthWords(p.milestones.next.estimatedMonth)}</span>
                  </li>
                )}
              </ul>
            )}
          </section>
        </div>
      )}
    </Panel>
  );
}
