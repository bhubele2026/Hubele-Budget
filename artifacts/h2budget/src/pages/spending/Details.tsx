import { useState } from "react";
import type { PeriodBreakdown } from "@workspace/api-client-react";
import { formatCurrency } from "@/lib/utils";
import { BiggestCharges } from "@/components/spending/BiggestCharges";
import { monthWords, type PeriodView } from "./periodDates";

const isZero = (v: string | null | undefined): boolean => Math.round(Number(v ?? 0) * 100) === 0;

/**
 * (W5) "Beside the plan" and the lines that reconcile the page. Collapsed. The
 * three "spent" figures on screen are named here: what counts toward the plan,
 * what is counted somewhere else, and every purchase on every account. All
 * amounts are the server's.
 */
export function Details({ data, view }: { data: PeriodBreakdown; view: PeriodView }) {
  const b = data.beside;
  const other = view === "week" ? { label: "Monthly allowance", v: b.monthly } : { label: "Weekly allowance", v: b.weekly };
  const lines: Array<[string, string | null, string]> = [
    ["Unplanned", b.unplanned, "unplanned"],
    [other.label, other.v, "other"],
    ["Matched to a bill", b.billMatched, "bill"],
    ["Reimbursable", b.reimbursable, "reimbursable"],
    ["All household purchases (all accounts)", b.householdSpend, "household"],
  ];
  // (W3) The charges list reads transactions, so it mounts only once Details is opened.
  const [opened, setOpened] = useState(false);
  return (
    <details
      className="surface rounded-card ring-1 ring-brand-line"
      data-testid="sp-details"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open) setOpened(true);
      }}
    >
      <summary className="press cursor-pointer px-4 py-3 text-body font-semibold text-brand-navy">Details</summary>
      <div className="space-y-3 border-t border-brand-line px-4 py-3">
        <dl className="space-y-1 text-body">
          <div className="flex justify-between gap-3">
            <dt className="text-neutral-700">Counts toward the {view === "week" ? "weekly" : "monthly"} plan</dt>
            <dd className="font-mono tabular-nums text-brand-ink" data-testid="sp-d-actual">{formatCurrency(data.actual)}</dd>
          </div>
          {data.carryOver != null && !isZero(data.carryOver) ? (
            <div className="flex justify-between gap-3">
              <dt className="text-neutral-700">Carried over</dt>
              <dd className="font-mono tabular-nums text-brand-ink" data-testid="sp-d-carry">{formatCurrency(data.carryOver)}</dd>
            </div>
          ) : null}
          {!isZero(data.refundFloorAdjustment) ? (
            <div className="flex justify-between gap-3">
              <dt className="text-neutral-700">Refund adjustment</dt>
              <dd className="font-mono tabular-nums text-brand-ink" data-testid="sp-d-floor">{formatCurrency(data.refundFloorAdjustment)}</dd>
            </div>
          ) : null}
        </dl>
        <div>
          <h3 className="text-label font-semibold text-brand-navy">Beside the plan</h3>
          <p className="mt-0.5 text-micro text-neutral-500" data-testid="sp-d-why">
            {view === "week"
              ? "The weekly plan counts weekly purchases and ones not filed yet. These are counted somewhere else."
              : "The monthly plan counts purchases marked monthly. These are counted somewhere else."}
          </p>
          <dl className="mt-2 space-y-1 text-body">
            {lines.map(([label, v, key]) =>
              v == null ? null : (
                <div key={key} className="flex justify-between gap-3">
                  <dt className="text-neutral-700">{label}</dt>
                  <dd className="font-mono tabular-nums text-brand-ink" data-testid={`sp-d-${key}`}>{formatCurrency(v)}</dd>
                </div>
              ),
            )}
          </dl>
        </div>
        {view === "month" && opened ? (
          <BiggestCharges monthStart={data.start} monthLabel={monthWords(data.start)} />
        ) : null}
      </div>
    </details>
  );
}
