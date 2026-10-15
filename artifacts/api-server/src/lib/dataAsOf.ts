/**
 * ⭐ (T1) WHICH BANK READING IS THIS ANSWER BUILT ON? — `dataAsOf` on every
 * response that carries the checking balance (`docs/contracts/checking-balance.md`).
 *
 *   snapshotAt  the bank reading the figures roll forward from
 *               (`forecast_settings.bank_snapshot_at`, as `computeCashSignal`
 *               reads it); null when there is no reading.
 *   computedAt  when this response was computed (the server's clock).
 *
 * The web keeps the newest `snapshotAt` it has seen (`lib/dataAsOf.ts`) and
 * shows an older answer as "Earlier reading … — updating…", never as current.
 * Additive and read-only: it names a moment, it computes no money.
 */
export interface DataAsOf {
  snapshotAt: string | null;
  computedAt: string;
}

export function dataAsOfOf(snapshotAt: Date | string | null | undefined, now: Date = new Date()): DataAsOf {
  let at: string | null = null;
  if (snapshotAt instanceof Date) {
    at = Number.isNaN(snapshotAt.getTime()) ? null : snapshotAt.toISOString();
  } else if (typeof snapshotAt === "string" && snapshotAt) {
    const ms = Date.parse(snapshotAt);
    at = Number.isNaN(ms) ? snapshotAt : new Date(ms).toISOString();
  }
  return { snapshotAt: at, computedAt: now.toISOString() };
}
