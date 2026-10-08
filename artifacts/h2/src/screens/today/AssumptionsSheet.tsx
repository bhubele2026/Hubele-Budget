import type { RefObject } from "react";
import type { MoneyPosition, Spine } from "@workspace/api-client-react";
import { Sheet } from "@/kit/Sheet";
import { centsValue, fmtMoney, MISSING, toAmount } from "@/lib/money";
import { shortDate, shortDateOfInstant, weekdayDate } from "@/lib/dates";

const SOURCE_WORDS = { plaid: "bank sync", manual: "entered by hand" } as const;

function Row({ label, amount, note }: { label: string; amount: number | null; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-rule py-2 first:border-t-0">
      <dt className="min-w-0 type-body text-ink">
        {label}
        {note && <span className="block type-caption text-ink-3">{note}</span>}
      </dt>
      <dd>
        {amount == null ? (
          <span className="type-figure-sm text-ink-3">{MISSING}</span>
        ) : (
          <data value={centsValue(amount)} className="type-figure-sm text-ink">
            {fmtMoney(amount)}
          </data>
        )}
      </dd>
    </div>
  );
}

/**
 * ⭐ HOW "ROOM IN THE PLAN" IS WORKED OUT — the bank balance, the payday, the
 * bills before it, the buffer and the reserves, then the server's own
 * assumptions and estimates word for word. Every figure is read from the spine
 * or `GET /money/position`; none is added up here.
 *
 * Available credit is never counted, and the sheet says so.
 */
export default function AssumptionsSheet({
  open,
  onOpenChange,
  returnFocusRef,
  spine,
  position,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  spine: Spine;
  position: MoneyPosition | undefined;
}) {
  const bank = spine.bank;
  const p = spine.position;
  const weekEnd = p.horizonKind === "week_end";
  const bankNote =
    bank.asOfDate && bank.source
      ? `as of ${shortDateOfInstant(bank.asOfDate)} · ${SOURCE_WORDS[bank.source]}`
      : undefined;
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      returnFocusRef={returnFocusRef}
      title="Room in the plan"
      description="What H2 counted to get this figure."
    >
      <dl className="flex flex-col" data-testid="assumptions">
        <Row label="Bank balance" amount={toAmount(bank.balance)} note={bankNote} />
        <div className="flex items-baseline justify-between gap-4 border-t border-rule py-2">
          <dt className="type-body text-ink">{weekEnd ? "Counted through" : "Payday"}</dt>
          <dd className="type-label text-ink" data-testid="assumption-payday">
            {weekEnd
              ? position?.horizon.lastDay
                ? weekdayDate(position.horizon.lastDay)
                : "Saturday"
              : p.paydayDate
                ? weekdayDate(p.paydayDate)
                : MISSING}
          </dd>
        </div>
        <Row
          label="Bills before then"
          amount={toAmount(position?.committedUntilPayday)}
          note={position ? undefined : "Loading the list of bills."}
        />
        <Row label="Cash buffer" amount={toAmount(position?.cashBuffer)} />
        <Row label="Held for goals" amount={toAmount(position?.reservesHeld)} />
        <Row label="Available until payday" amount={toAmount(p.availableUntilPayday)} />
        <Row label="Left under this week's limit" amount={toAmount(p.remainingWeek)} />
      </dl>
      <p className="mt-3 type-caption text-ink-2">Room is the smaller of the last two. It is not a target to spend.</p>

      {position && position.estimates.length > 0 && (
        <ul className="mt-5 flex flex-col gap-1" data-testid="estimates">
          {position.estimates.map((e) => {
            const n = toAmount(e.amount);
            return (
              <li key={`${e.itemId}-${e.date}`} className="type-body text-ink">
                {e.label} — estimated {fmtMoney(n == null ? null : Math.abs(n))}
                <span className="type-caption text-ink-3"> · {shortDate(e.date)}</span>
              </li>
            );
          })}
        </ul>
      )}

      {position && position.assumptions.length > 0 && (
        <ul className="mt-5 flex list-disc flex-col gap-1 pl-5" data-testid="assumption-list">
          {position.assumptions.map((a) => (
            <li key={a} className="type-body text-ink-2">
              {a}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-5 type-label text-ink" data-testid="credit-line">
        Available credit is never counted.
      </p>
    </Sheet>
  );
}
