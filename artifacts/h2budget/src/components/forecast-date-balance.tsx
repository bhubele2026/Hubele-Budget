import { useState } from "react";
import type { CashSignal } from "@workspace/api-client-react";
import type { DataState } from "@/lib/queryState";
import { card, cardHead, input, Stat } from "@/ui";
import { formatCurrency, formatDate } from "@/lib/utils";

/** Date lookup uses the server curve; it never builds a second projection. */
export function ForecastDateBalance({
  signal,
  state,
  defaultDate = null,
}: {
  signal: CashSignal | undefined;
  /** The projection query's state. Without one, a missing signal reads as still loading. */
  state?: DataState;
  /**
   * ⭐ (T3) The day to show before one is picked — the Forecast page passes its
   * month picker's last day ("At the end of Oct 31"). Used only when the curve
   * has that day: a lookup, never a second calculation. Otherwise the curve's
   * last day, as before.
   */
  defaultDate?: string | null;
}) {
  const [chosenDate, setChosenDate] = useState("");
  const daily = signal?.status === "no_data" ? [] : (signal?.daily ?? []);
  const first = daily[0]?.date;
  const last = daily.at(-1)?.date;
  const preset = defaultDate && daily.some((d) => d.date === defaultDate) ? defaultDate : null;
  const date = chosenDate || preset || last || "";
  const point = daily.find((d) => d.date === date);
  const amount = point ? Number(point.balance) : NaN;

  // With no curve, say why. The bank's reading is the only checking balance
  // (owner, 10/15): with none yet, linking a bank is the fix. While the
  // forecast loads or after it failed, that would be wrong.
  const emptyHint = !signal
    ? state === "failed"
      ? "Couldn't load the forecast"
      : "Loading the forecast…"
    : signal.status === "no_data"
      ? "No bank balance yet · Link a bank"
      : "No forecast days to show";

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
        {/* (T2/T3) Rust only below zero; a day under the buffer stays calm. */}
        <Stat
          label="Expected checking balance"
          value={Number.isFinite(amount) ? formatCurrency(amount) : "—"}
          tone={Number.isFinite(amount) && amount < 0 ? "bad" : "navy"}
          hint={
            point
              ? `At the end of ${formatDate(point.date)}`
              : daily.length
                ? "Choose a date inside the forecast window"
                : emptyHint
          }
        />
      </div>
    </section>
  );
}
