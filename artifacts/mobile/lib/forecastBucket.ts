import type {
  ForecastEvent,
  ForecastResolution,
} from "@workspace/api-client-react";

/**
 * Mobile-side projection of the desktop `forecastMatch` rules used by
 * the Forecast / Missed screens (Task #489). Kept narrow on purpose:
 * we only need pending-plan rows + the missed bucket for the per-row
 * "Mark missed" / "Set new date" / "Skip" actions to mirror the web
 * Forecast page. The new `skipped` resolution status removes the
 * occurrence from the list entirely (matching the server projection
 * and the desktop register/bucket filters).
 */
export type PlanRowStatus = "pending" | "future" | "matched" | "missed";

export type PlanRow = {
  itemId: string;
  /** Current display date (rescheduledTo when the occurrence was moved). */
  date: string;
  /** Original occurrence date — the resolution key for upserts. */
  occurrenceDate: string;
  label: string;
  amount: number;
  status: PlanRowStatus;
  resolutionId?: string;
};

export type MissedRow = {
  resolutionId: string;
  itemId: string;
  occurrenceDate: string;
  label: string;
  amount: number;
};

function parseISO(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

export function todayISODate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function monthKeyOf(iso: string): string {
  return iso.slice(0, 7);
}

/** Build the per-occurrence plan rows for the mobile Forecast view.
 *  Filters out matched and skipped rows; routes rescheduled overrides
 *  to their new date (mirroring `buildLineRegister`). */
export function buildPlanRows(opts: {
  events: ForecastEvent[];
  resolutions: ForecastResolution[];
  today?: Date;
}): PlanRow[] {
  const today = opts.today ?? new Date();
  const todayMs = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  ).getTime();

  const byKey = new Map<string, ForecastResolution>();
  for (const r of opts.resolutions) {
    if (r.recurringItemId && r.occurrenceDate) {
      byKey.set(`${r.recurringItemId}|${r.occurrenceDate}`, r);
    }
  }

  const out: PlanRow[] = [];
  for (const ev of opts.events) {
    const origKey = `${ev.itemId}|${ev.date}`;
    const orig = byKey.get(origKey);
    let date = ev.date;
    let stored: ForecastResolution | undefined = orig;
    if (orig?.status === "rescheduled" && orig.rescheduledTo) {
      date = orig.rescheduledTo;
      const atNew = byKey.get(`${ev.itemId}|${date}`);
      if (atNew && atNew.id !== orig.id) stored = atNew;
    }
    if (stored?.status === "skipped") continue;
    if (stored?.status === "matched") continue;
    let status: PlanRowStatus;
    if (stored?.status === "missed" || stored?.status === "dismissed") {
      status = "missed";
    } else if (parseISO(date) > todayMs) {
      status = "future";
    } else {
      status = "pending";
    }
    out.push({
      itemId: ev.itemId,
      date,
      occurrenceDate: ev.date,
      label: ev.label,
      amount: ev.amount,
      status,
      resolutionId: stored?.id,
    });
  }
  return out;
}

/** Missed-bucket rows for a given month, joined with their original
 *  plan event so we can show the user the bill name + amount. */
export function buildMissedRows(opts: {
  events: ForecastEvent[];
  resolutions: ForecastResolution[];
  monthKey: string;
}): MissedRow[] {
  const eventByKey = new Map<string, ForecastEvent>();
  for (const ev of opts.events) {
    eventByKey.set(`${ev.itemId}|${ev.date}`, ev);
  }
  const out: MissedRow[] = [];
  for (const r of opts.resolutions) {
    if (r.status !== "missed" && r.status !== "dismissed") continue;
    if (!r.recurringItemId || !r.occurrenceDate) continue;
    if (monthKeyOf(r.occurrenceDate) !== opts.monthKey) continue;
    const ev = eventByKey.get(`${r.recurringItemId}|${r.occurrenceDate}`);
    out.push({
      resolutionId: r.id,
      itemId: r.recurringItemId,
      occurrenceDate: r.occurrenceDate,
      label: ev?.label ?? "",
      amount: ev?.amount ?? 0,
    });
  }
  out.sort((a, b) => (a.occurrenceDate < b.occurrenceDate ? -1 : 1));
  return out;
}

/** Validate a "Set new date" draft against the desktop rules: must be
 *  parseable, strictly after today, and strictly after the original
 *  occurrence date. Returns null on success or a user-facing reason. */
export function validateNewDate(
  draft: string,
  occurrenceDate: string,
  today: Date = new Date(),
): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft)) return "Use YYYY-MM-DD.";
  const todayIso = todayISODate(today);
  if (draft <= todayIso) return "Pick a date after today.";
  if (draft <= occurrenceDate) {
    return "Pick a date after the original occurrence.";
  }
  return null;
}
