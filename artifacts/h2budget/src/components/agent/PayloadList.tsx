import { fmtMoney } from "@/lib/money";
import { payloadLines } from "@/lib/agentTrail";

/** A finding's payload as words and figures; refs are left out and nothing is derived. */
export function PayloadList({ payload }: { payload: Record<string, unknown> }) {
  const lines = payloadLines(payload);
  if (lines.length === 0) return <p className="text-body text-neutral-600">No figures came with this one.</p>;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-body" data-testid="why-figures">
      {lines.map((l) => (
        <div key={l.label} className="contents">
          <dt className="text-neutral-600">{l.label}</dt>
          <dd className="text-brand-navy">
            {typeof l.value === "number" ? (
              <span className="font-mono tabular-nums">{l.money ? fmtMoney(l.value, { whole: true }) : l.value}</span>
            ) : (
              l.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
