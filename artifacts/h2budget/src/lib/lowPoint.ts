import { fmtMoney, toAmount } from "@/lib/money";

/**
 * ⭐ THE PROJECTED LOW POINT, IN WORDS — one pure reading of `spine.forecast`
 * for every surface that shows it.
 *
 * The server's verdict (`computeCashSignal().status`, api-server
 * lib/cashSignal.ts) is the only judge of where the low point sits:
 *   - `no_data`  no bank balance, so no projection at all;
 *   - `ready`    the low point is at least $200 over the buffer;
 *   - `tight`    it is over the buffer by less than $200;
 *   - `not_yet`  it is UNDER the buffer.
 * Only `no_data` hides the figure. `not_yet` is the case that most needs
 * showing: the dashboard used to treat it as "no forecast" and printed "—" on
 * exactly the days the household was heading under its floor.
 *
 * Code computes nothing new here: the value, date and buffer are the spine's
 * own; this only picks words and a tone. A negative low point carries the bad
 * tone. A stale bank balance never blanks the figure; the words say so.
 */
export type LowPointKind = "none" | "ok" | "tight" | "below";

export interface LowPointForecast {
  lowPoint: string | number | null;
  lowPointDate: string | null;
  status: "ready" | "tight" | "not_yet" | "no_data" | string;
  cashBuffer?: string | number | null;
}

export interface LowPointView {
  kind: LowPointKind;
  /** The low point in dollars; null only when there is no projection. */
  value: number | null;
  /** YYYY-MM-DD, or null. */
  date: string | null;
  /** One plain phrase: "below your $500 buffer". */
  words: string;
  /** "bad" when the low point is under zero. */
  tone: "bad" | "neutral";
  /** The bank balance behind the projection is out of date. */
  stale: boolean;
}

const KIND: Readonly<Record<string, LowPointKind>> = {
  ready: "ok",
  tight: "tight",
  not_yet: "below",
};

export function lowPointView(
  forecast: LowPointForecast | null | undefined,
  opts: { buffer?: string | number | null; stale?: boolean } = {},
): LowPointView {
  const stale = opts.stale === true;
  const value = toAmount(forecast?.lowPoint ?? null);
  const kind: LowPointKind =
    !forecast || forecast.status === "no_data" || value == null ? "none" : (KIND[forecast.status] ?? "none");
  if (kind === "none") {
    return { kind, value: null, date: null, words: "No bank balance yet, so no forecast", tone: "neutral", stale };
  }
  const buffer = toAmount(opts.buffer ?? forecast?.cashBuffer ?? null);
  const yours = buffer == null ? "your buffer" : `your ${fmtMoney(buffer, { whole: buffer === Math.round(buffer) })} buffer`;
  const phrase = kind === "below" ? `below ${yours}` : kind === "tight" ? `just above ${yours}` : `above ${yours}`;
  return {
    kind,
    value,
    date: forecast?.lowPointDate ?? null,
    words: stale ? `${phrase}, from an out-of-date bank balance` : phrase,
    tone: value! < 0 ? "bad" : "neutral",
    stale,
  };
}
