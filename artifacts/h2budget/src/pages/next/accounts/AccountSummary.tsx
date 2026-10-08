import type { AmexWeeklyPayoffCard, Debt } from "@workspace/api-client-react";
import { Panel, StatBlock } from "@/components/next";
import { BankSnapshotFreshness } from "@/components/bank-snapshot-freshness";
import { ForecastLegend } from "./ForecastLegend";
import { STATE_WORD, type AccountEntry } from "./entries";

const BLANK = "—";
const ord = (n: number) => {
  const v = n % 100;
  const s = ["th", "st", "nd", "rd"];
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};
/** A figure only when the API sent one; zero or missing stays an em-dash. */
const money = (v: string | number | null | undefined): string | number => {
  if (v === null || v === undefined || v === "") return BLANK;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) && n !== 0 ? n : BLANK;
};

export interface SnapshotLite { balance: string; at: string; source: "manual" | "plaid" }

export function AccountSummary({
  entry, debt, payoffCard, snapshot,
}: {
  entry: AccountEntry;
  debt: Debt | null;
  payoffCard: AmexWeeklyPayoffCard | null;
  snapshot: SnapshotLite | null;
}) {
  const id = entry.identity;
  return (
    <Panel title="Summary" sub={`${id.label}${id.mask4 ? ` ••${id.mask4}` : ""}`} accent={id.accent} span={4} data-testid="account-summary">
      {id.isCard ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <StatBlock label="Current balance" value={money(debt?.balance)} />
            <StatBlock label="Statement balance" value={money(payoffCard?.statementBalance)} />
            <StatBlock label="Minimum payment" value={money(debt?.minPayment)} />
            <StatBlock label="Payment due" value={debt?.dueDay ? `${ord(debt.dueDay)} of the month` : BLANK} />
          </div>
          <StatBlock
            label="This week's charges"
            value={payoffCard ? money(payoffCard.weekCharges) : BLANK}
            hint={payoffCard ? `${payoffCard.chargeCount} charge${payoffCard.chargeCount === 1 ? "" : "s"} · ${Math.round(payoffCard.pctOfStatementThisWeek)}% of the statement` : undefined}
          />
          <ForecastLegend card={id} />
        </div>
      ) : (
        <div className="space-y-4">
          <StatBlock label="Balance today" value={snapshot ? money(snapshot.balance) : BLANK} />
          {snapshot ? (
            <div className="text-micro text-neutral-500"><BankSnapshotFreshness source={snapshot.source} at={snapshot.at} /></div>
          ) : (
            <p className="text-micro text-neutral-500">No balance reading for this account yet.</p>
          )}
        </div>
      )}
      <p className="mt-3 text-micro text-neutral-500" data-testid="summary-state">{STATE_WORD[entry.state]}</p>
    </Panel>
  );
}
