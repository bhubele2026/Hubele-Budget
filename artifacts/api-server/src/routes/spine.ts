import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, debtsTable } from "@workspace/db";
import { payoffPct } from "@workspace/avalanche-core";
import { requireAuth } from "../middlewares/requireAuth";
import {
  computeCashSignal,
  runwayDaysFrom,
  weekStartFor,
  weekEndFor,
  fmtISO,
} from "../lib/cashSignal";
import { buildSpendingFacts } from "../lib/spendingFacts";
import { buildBillsSummary, pickNextBill, todayDate } from "../lib/billsSummary";
import { computeReviewCount } from "../lib/reviewCount";

const router: IRouter = Router();

/**
 * ⭐ THE SPINE. One request, one snapshot, one set of numbers.
 *
 * The app used to open by firing four independent queries from four tiles —
 * spending facts, bills summary, the whole forecast engine, and every debt row
 * — and then a fifth for the review badge. Five round trips before the front
 * door finished drawing, and five chances for two surfaces to quote the same
 * household at two different moments. This endpoint replaces all of it: every
 * figure below is read ONCE, at ONE instant (`asOf`), and handed to whoever
 * needs it.
 *
 * ⚠️ NOT ONE NUMBER IN HERE IS CALCULATED IN HERE. Every field is the return
 * value of the same function the owning page's own endpoint calls:
 *
 *   bank.balance / bank.asOfDate  → computeCashSignal().bankToday / .snapshotAt
 *   forecast.lowPoint / .lowPointDate → computeCashSignal().lowestProjected / .lowestDate
 *   forecast.runwayDays           → runwayDaysFrom(signal.daily)      [lib/cashSignal]
 *   spentMonth / spentWeek        → buildSpendingFacts().realSpend.total
 *   nextBill / billsDueCount      → pickNextBill(buildBillsSummary())  [lib/billsSummary]
 *   debt.payoffPct                → payoffPct()          [@workspace/avalanche-core]
 *   reviewCount                   → computeReviewCount()  [lib/reviewCount]
 *
 * `spine.integration.test.ts` asserts every one of those equals what the owning
 * endpoint returns, to the cent. If a future change makes two tiles disagree,
 * that test fails — agreement is enforced, not hoped for.
 *
 * ⚠️ THE DEBT FIELD IS A PERCENTAGE AND NOTHING ELSE. No balance, no amount
 * owed, no total — not on this endpoint, ever, because this is the payload the
 * landing page paints and the standing rule is that the front door never shows
 * what is owed. The ratio is computed where the balances already are so the
 * balances never have to cross the wire.
 *
 * ⚠️ NO PLAID CALL ON THIS PATH. The debts read below is a plain SELECT, not
 * `GET /debts` — that route opportunistically refreshes stale linked accounts
 * against Plaid's API, which is a fine thing for the Debts page to do on demand
 * and a terrible thing to put in front of first paint.
 */
router.get("/spine", requireAuth, async (req, res): Promise<void> => {
  const householdId = req.householdId!;
  const ownerUserId = req.householdOwnerId!;

  const today = todayDate();
  const todayISO = fmtISO(today);
  const monthStartISO = fmtISO(new Date(today.getFullYear(), today.getMonth(), 1));

  // ⚠️ `horizonDays: 90` is not a default — it is the horizon the Forecast tile
  // and the Forecast Overview page both request. Ask for a different window and
  // the low point stops matching the page that shows it.
  const [signal, monthFacts, weekFacts, billsSummary, debtRows, reviewCount] =
    await Promise.all([
      computeCashSignal(householdId, ownerUserId, { horizonDays: 90 }),
      buildSpendingFacts(householdId, monthStartISO, todayISO),
      buildSpendingFacts(householdId, weekStartFor(today), weekEndFor(today)),
      buildBillsSummary(householdId, ownerUserId),
      db.select().from(debtsTable).where(eq(debtsTable.householdId, householdId)),
      computeReviewCount(householdId, ownerUserId),
    ]);

  const { nextBill, billsDueCount } = pickNextBill(billsSummary, today);

  res.json({
    asOf: new Date().toISOString(),
    bank: {
      balance: signal.bankToday,
      asOfDate: signal.snapshotAt,
    },
    spentMonth: monthFacts.realSpend.total,
    spentWeek: weekFacts.realSpend.total,
    nextBill,
    billsDueCount,
    forecast: {
      lowPoint: signal.lowestProjected,
      lowPointDate: signal.lowestDate,
      runwayDays: runwayDaysFrom(signal.daily),
    },
    debt: {
      payoffPct: payoffPct(debtRows),
    },
    reviewCount,
  });
});

export default router;
