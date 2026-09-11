import { useState } from "react";
import type { CashSignal } from "@workspace/api-client-react";
import { card, cardHead, input, Stat, Foot } from "@/ui";
import { formatCurrency, formatDate } from "@/lib/utils";

/** Date lookup uses the server curve; it never builds a second projection. */
export function ForecastDateBalance({
  signal,
}: {
  signal: CashSignal | undefined;
}) {
  const [chosenDate, setChosenDate] = useState("");
  const daily = signal?.status === "no_data" ? [] : (signal?.daily ?? []);
  const first = daily[0]?.date;
  const last = daily.at(-1)?.date;
  const date = chosenDate || last || "";
  const point = daily.find((d) => d.date === date);
  const amount = point ? Number(point.balance) : NaN;
  return (
    <section className={card} data-testid="forecast-date-balance">
      <div className={cardHead}>
        <label
          htmlFor="forecast-balance-date"
          className="text-title font-semibold text-brand-navy"
        >
          How much will we have?
        </label>
        <div className="ml-auto w-44 shrink-0">
          <input
            id="forecast-balance-date"
            type="date"
            className={input}
            value={date}
            min={first}
            max={last}
            disabled={!daily.length}
            onChange={(e) => setChosenDate(e.target.value)}
          />
        </div>
      </div>
      <div className="p-4">
        <Stat
          label="Expected checking balance"
          value={Number.isFinite(amount) ? formatCurrency(amount) : "—"}
          tone={
            Number.isFinite(amount) && amount < Number(signal?.cashBuffer ?? 0)
              ? "bad"
              : "navy"
          }
          hint={
            point
              ? `At the end of ${formatDate(point.date)}`
              : daily.length
                ? "Choose a date inside the forecast window"
                : "Set a bank balance and load the forecast"
          }
        />
      </div>
      <Foot>
        Based on recorded bank activity, scheduled bills, income, and debt
        payments. Additional unplanned purchases will reduce this balance.
      </Foot>
    </section>
  );
}
