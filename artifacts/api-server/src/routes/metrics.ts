import { Router, type IRouter } from "express";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { db, householdMetricsDailyTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { requireOwner } from "../middlewares/requireOwner";
import { addDaysISO, householdTodayISO } from "../lib/householdClock";
import { runMetricsSnapshot } from "../jobs/handlers/metricsSnapshot";

const router: IRouter = Router();

/** The most days one `GET /metrics` may ask for (inclusive of both ends). */
export const MAX_METRICS_DAYS = 93;
const DEFAULT_METRICS_DAYS = 30;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDay(s: string): boolean {
  return DAY_RE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
}

function dayCount(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

function shape(r: typeof householdMetricsDailyTable.$inferSelect) {
  return { asOf: r.asOf, version: r.version, computedAt: r.computedAt.toISOString(), metrics: r.metrics };
}

/**
 * (PR-E) The stored daily metrics, oldest first. READ-ONLY: the nightly
 * `metrics.snapshot` job writes them; nothing is computed on this request.
 * `from`/`to` default to the 30 days ending today; at most 93 days inclusive.
 * `latest` is the newest row on or before `to`, even when it is older than `from`.
 */
router.get("/metrics", requireAuth, async (req, res): Promise<void> => {
  const householdId = req.householdId!;
  const q = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
  const to = q(req.query.to) ?? householdTodayISO();
  const from = q(req.query.from) ?? addDaysISO(to, -(DEFAULT_METRICS_DAYS - 1));
  if (!isRealDay(from) || !isRealDay(to)) {
    res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
    return;
  }
  if (from > to) {
    res.status(400).json({ error: "from must not be after to" });
    return;
  }
  if (dayCount(from, to) > MAX_METRICS_DAYS) {
    res.status(400).json({ error: `the range is capped at ${MAX_METRICS_DAYS} days` });
    return;
  }
  const rows = await db
    .select()
    .from(householdMetricsDailyTable)
    .where(
      and(
        eq(householdMetricsDailyTable.householdId, householdId),
        gte(householdMetricsDailyTable.asOf, from),
        lte(householdMetricsDailyTable.asOf, to),
      ),
    )
    .orderBy(asc(householdMetricsDailyTable.asOf));
  const [latest] = await db
    .select()
    .from(householdMetricsDailyTable)
    .where(and(eq(householdMetricsDailyTable.householdId, householdId), lte(householdMetricsDailyTable.asOf, to)))
    .orderBy(desc(householdMetricsDailyTable.asOf))
    .limit(1);
  res.json({ from, to, rows: rows.map(shape), latest: latest ? shape(latest) : null });
});

/**
 * (PR-E, owner) Run the nightly pass for one day now: snapshots, milestones,
 * metrics. `?date=YYYY-MM-DD` (default today; not in the future). Idempotent.
 */
router.post("/metrics/recompute", ...requireOwner, async (req, res): Promise<void> => {
  const householdId = req.householdId!;
  const ownerUserId = req.householdOwnerId!;
  const raw = typeof req.query.date === "string" ? req.query.date : undefined;
  if (raw !== undefined && !isRealDay(raw)) {
    res.status(400).json({ error: "date must be YYYY-MM-DD" });
    return;
  }
  const day = raw ?? householdTodayISO();
  if (day > householdTodayISO()) {
    res.status(400).json({ error: "date must not be in the future" });
    return;
  }
  res.json(await runMetricsSnapshot(householdId, ownerUserId, day));
});

export default router;
