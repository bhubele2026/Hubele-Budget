import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/requireAuth";
import { requireOwner } from "../middlewares/requireOwner";
import { computeCashSignal } from "../lib/cashSignal";
import { computeDebtPlan } from "../lib/debtPlan";
import { confirmDebtPaymentClaims } from "../lib/debtPaymentConfirm";
import { syncDebtLedgerEvents } from "../lib/debtLedger";
import { writeAchievedMilestones, writeDebtProgressSnapshots } from "../lib/debtProgressSnapshot";
import { householdTodayISO } from "../lib/householdClock";

const router: IRouter = Router();

/**
 * (PR-D) The debt plan: strategies compared, a debt-free RANGE (months, never
 * one date), milestones reached and next, planned debt payments for the next
 * 60 days, and what the bank has confirmed this month. Read-only.
 *
 * ⚠️ `horizonDays: 90` is the spine's horizon. The spine's `debt.*` fields are
 * computed from the same signal shape by the same function
 * (`computeDebtHeadline`, inside `computeDebtPlan`); a different horizon here
 * could move which overdue plans count as paid and break parity.
 */
router.get("/debt-plan", requireAuth, async (req, res): Promise<void> => {
  const householdId = req.householdId!;
  const ownerUserId = req.householdOwnerId!;
  const signal = await computeCashSignal(householdId, ownerUserId, { horizonDays: 90 });
  res.json(await computeDebtPlan(householdId, ownerUserId, signal));
});

/**
 * (PR-D, owner) Re-run the debt passes over the recent window: classify the
 * liability accounts' rows onto the ledger (120 days) and pair open payment
 * claims with bank rows. Idempotent — the end of every Plaid sync runs the same
 * two passes over the rows it synced.
 */
router.post("/debt-plan/reconcile", ...requireOwner, async (req, res): Promise<void> => {
  const householdId = req.householdId!;
  const ledger = await syncDebtLedgerEvents(householdId);
  const claims = await confirmDebtPaymentClaims(householdId);
  res.json({
    ledgerEventsWritten: ledger.written,
    ledgerEventsCleared: ledger.cleared,
    claimsConfirmed: claims.confirmed.length,
    claimsReverted: claims.reverted,
  });
});

/**
 * (PR-D, owner) Write the day's debt progress snapshot and any milestones now
 * reached. `?date=YYYY-MM-DD` (default: the household's today). Idempotent:
 * snapshots are upserted, milestones insert-only. The nightly job will call the
 * same two functions.
 */
router.post("/debt-plan/snapshot", ...requireOwner, async (req, res): Promise<void> => {
  const householdId = req.householdId!;
  const raw = typeof req.query.date === "string" ? req.query.date : undefined;
  if (raw !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    res.status(400).json({ error: "date must be YYYY-MM-DD" });
    return;
  }
  const asOf = raw ?? householdTodayISO();
  const snapshots = await writeDebtProgressSnapshots(householdId, asOf);
  const milestones = await writeAchievedMilestones(householdId, asOf);
  res.json({ asOf, snapshotsWritten: snapshots.written, milestonesInserted: milestones.inserted });
});

export default router;
