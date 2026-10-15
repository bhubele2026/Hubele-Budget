import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, debtsTable } from "@workspace/db";
import { payoffPct } from "@workspace/avalanche-core";
import { requireAuth } from "../middlewares/requireAuth";
import {
  bankBalanceParts,
  computeCashSignalDetailed,
  runwayDaysFrom,
  weekStartFor,
  weekEndFor,
  fmtISO,
} from "../lib/cashSignal";
import { buildMoneyPosition } from "../lib/moneyPosition";
import { readMonthAllowance } from "../lib/periodBreakdown";
import { buildSpendingFacts } from "../lib/spendingFacts";
import { findSupersededPendingForRange } from "../lib/supersededPending";
import { buildBillsSummary, pickNextBill, todayDate } from "../lib/billsSummary";
import { computeReviewCount } from "../lib/reviewCount";
import { withPendingPayments } from "../lib/debtPending";
import { computeBankFreshness } from "../lib/bankFreshness";
import { computeDebtHeadline } from "../lib/debtPlan";
import { readBankConfidence } from "../lib/bankConfidence";

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
 *   bank.snapshot / .sinceSnapshot → bankBalanceParts(ledger)        [lib/cashSignal]
 *                                   (WP1; the two halves of bank.balance from the
 *                                   same ledger; also /forecast/bank-balance-explain
 *                                   .snapshot and .ledger.sinceAnchor)
 *   bank.account                  → computeCashSignal().account (WP1: with its ids)
 *   bank.source / .lastContactAt / .lastFailureAt / .stale / .staleReason
 *                                 → computeBankFreshness()  [lib/bankFreshness]
 *                                   (also /forecast/bank-balance-explain .freshness)
 *   forecast.lowPoint / .lowPointDate → computeCashSignal().lowestProjected / .lowestDate
 *   forecast.runwayDays           → runwayDaysFrom(signal.daily)      [lib/cashSignal]
 *   forecast.cashBuffer / .status → computeCashSignal().cashBuffer / .status
 *   spentMonth / spentWeek        → buildSpendingFacts().householdSpend.total
 *   nextBill / billsDueCount      → pickNextBill(buildBillsSummary())  [lib/billsSummary]
 *   debt.payoffPct                → payoffPct()          [@workspace/avalanche-core]
 *                                   over withPendingPayments() rows [lib/debtPending]
 *   debt.nextMilestone / .paidDownMtd → computeDebtHeadline(signal)  [lib/debtPlan]
 *                                   (also GET /debt-plan .milestones.next / .paidDownGenuineMtd)
 *   debt.confirmedPaymentsMtd / .newChargesMtd → computeDebtHeadline(signal)
 *                                   (V5; also GET /debt-plan .confirmedMtd / .newChargesMtd)
 *                                   — amounts PAID and CHARGED, never a balance
 *   reviewCount                   → computeReviewCount()  [lib/reviewCount]
 *   position.*                    → buildMoneyPosition()  [lib/moneyPosition]
 *                                   (also GET /money/position), handed THIS
 *                                   request's own cash-signal, freshness and
 *                                   pending-pair reads so one request builds
 *                                   one ledger. (Q1) .knownWeek / .unresolvedWeek /
 *                                   .provisional / .remainingWeekKnown = GET
 *                                   /money/period-breakdown?period=week (current)
 *                                   .known / .unresolved.amount / .provisional / .remaining
 *   bankConfidence.*              → readBankConfidence()  [lib/bankConfidence]
 *                                   (Q1; .check = GET /banking/review .balanceCheck and
 *                                   .pendingCount = its .cashFlow.pendingCount for the
 *                                   forecast account; .bankBalance / .bankAsOf =
 *                                   bank.snapshot; .h2Balance = bank.balance)
 *   monthAllowance.*            → readMonthAllowance()  [lib/periodBreakdown]
 *                                   (S3; also GET /money/period-breakdown?period=month
 *                                   .plan.amount / .actual, and S6 .remaining / .over
 *                                   via allowancePeriodFigures), handed this
 *                                   request's own cash-signal read
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
 * `GET /debts` (which, since P3, never calls Plaid either: liabilities refresh
 * only on a person's Sync or a debt's own Refresh). The freshness read is our
 * own tables too: the snapshot, the item behind it, and its sync attempts.
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
  // (PR7b review M1; PR-D review M3) The pending pairs, read ONCE and shared by
  // both spend windows: one windowed read over the span covering both, which
  // is the whole-ledger answer for every row in it
  // (`findSupersededPendingForRange`). `buildSpendingFacts` reads the same
  // answer on its own for /reports/spending-facts, so parity is unchanged.
  // `.then` attaches both consumers at once, so a failed read rejects the
  // Promise.all instead of surfacing as an unhandled rejection.
  const weekStartISO = weekStartFor(today);
  const weekEndISO = weekEndFor(today);
  const supersedePromise = findSupersededPendingForRange(
    householdId,
    monthStartISO < weekStartISO ? monthStartISO : weekStartISO,
    todayISO > weekEndISO ? todayISO : weekEndISO,
  );
  // (PR-B1) The cash signal and the freshness are read once and handed to the
  // money position too, so its figures sit on the very curve the forecast
  // fields below quote.
  const cashPromise = computeCashSignalDetailed(householdId, ownerUserId, { horizonDays: 90 });
  const freshnessPromise = computeBankFreshness(householdId, ownerUserId);
  const [cash, monthFacts, weekFacts, billsSummary, debtRows, reviewCount, freshness, position, monthAllowance, bankConfidence] =
    await Promise.all([
      cashPromise,
      supersedePromise.then((supersede) =>
        buildSpendingFacts(householdId, monthStartISO, todayISO, { supersede }),
      ),
      supersedePromise.then((supersede) =>
        buildSpendingFacts(householdId, weekStartISO, weekEndISO, { supersede }),
      ),
      buildBillsSummary(householdId, ownerUserId),
      db.select().from(debtsTable).where(eq(debtsTable.householdId, householdId)),
      computeReviewCount(householdId, ownerUserId),
      freshnessPromise,
      buildMoneyPosition(householdId, ownerUserId, {
        cash: cashPromise,
        freshness: freshnessPromise,
        supersede: supersedePromise,
      }),
      readMonthAllowance(householdId, ownerUserId, { cash: cashPromise }),
      // (Q1) Can the balance be trusted: the check, the pending rows, the bank's
      // own figure beside H2's — on THIS request's signal and freshness.
      readBankConfidence(householdId, ownerUserId, { cash: cashPromise, freshness: freshnessPromise }),
    ]);
  const signal = cash.signal;
  // (WP1) The snapshot and what the roll adds since, from the very ledger that
  // computed `bankToday` — so the account pages can show both halves beside it.
  const bankParts = bankBalanceParts(cash.ledger);

  const { nextBill, billsDueCount } = pickNextBill(billsSummary, today);

  // (C10) Net tagged-but-unposted payments before deriving the percentage.
  // `payoffPct` nets whatever `pendingPaymentTotal` it is handed, and a plain
  // `debtsTable` row has no such column — so without this enrichment the spine
  // would silently fall back to raw balances and quote a lower "% paid" than
  // the Debts and Avalanche pages, which is the exact disagreement C10 exists
  // to end. One extra read of already-visible transaction rows, on the same
  // household, off the same connection.
  const [debtRowsWithPending, debtHeadline] = await Promise.all([
    withPendingPayments(householdId, debtRows),
    // (PR-D) The same function `GET /debt-plan` runs, over the same 90-day
    // signal. Both fields are safe for the front door: a month and a label, and
    // an amount PAID — never a balance.
    computeDebtHeadline(householdId, ownerUserId, signal),
  ]);

  res.json({
    asOf: new Date().toISOString(),
    bank: {
      balance: signal.bankToday,
      asOfDate: signal.snapshotAt,
      // Whether that balance can be trusted right now. Decided here, from the
      // snapshot and the feed that refreshes it, so no screen guesses staleness
      // from a timestamp of its own.
      source: freshness.source,
      lastContactAt: freshness.lastContactAt,
      lastFailureAt: freshness.lastFailureAt,
      stale: freshness.stale,
      staleReason: freshness.staleReason,
      // (WP1) What `balance` is made of, and whose it is. The snapshot is the
      // bank's own figure as read (a different number from `balance` whenever
      // rows landed since); `sinceSnapshot` is what the ledger added on top; the
      // account carries its ids so no screen has to match it by mask. ⚠️ Still
      // the household's own cash: nothing under `bank` may name a debt, a limit
      // or credit (`spineParity` scans for it).
      snapshot: bankParts.snapshot,
      sinceSnapshot: bankParts.sinceSnapshot,
      account: signal.account,
    },
    // (PR7) Household spending: every purchase on any account, categorized or
    // not, through the one spending rule (card payments, transfers, debt
    // payments and reimbursable charges out).
    spentMonth: monthFacts.householdSpend.total,
    spentWeek: weekFacts.householdSpend.total,
    nextBill,
    billsDueCount,
    forecast: {
      lowPoint: signal.lowestProjected,
      lowPointDate: signal.lowestDate,
      runwayDays: runwayDaysFrom(signal.daily),
      // The buffer and the verdict ride along with the low point they judge.
      // Reports shows all three in one tile; read from two requests they can
      // land a minute apart and the tile says "Ready" over a low point that is
      // already under the floor.
      cashBuffer: signal.cashBuffer,
      status: signal.status,
    },
    debt: {
      payoffPct: payoffPct(debtRowsWithPending),
      nextMilestone: debtHeadline.nextMilestone,
      paidDownMtd: debtHeadline.paidDownMtd,
      // (V5) The honest other half: gross confirmed payments and new charges
      // this month. Amounts paid and charged — never a balance or credit.
      confirmedPaymentsMtd: debtHeadline.confirmedPaymentsMtd,
      newChargesMtd: debtHeadline.newChargesMtd,
    },
    reviewCount,
    // ⭐ (PR-B1) The money position's headline. Every field is the
    // `GET /money/position` field of the same name (`horizonKind` is its
    // `horizon.kind`). ⚠️ Never credit, a limit, a debt balance or an amount owed.
    position: {
      safeToSpendNow: position.safeToSpendNow,
      remainingWeek: position.remainingWeek,
      availableUntilPayday: position.availableUntilPayday,
      paydayDate: position.paydayDate,
      horizonKind: position.horizon.kind,
      withinPlan: position.withinPlan,
      confidence: position.confidence,
      degraded: position.degraded,
      // (V5) The household's own carry-over for this week, or null.
      weekAdjustment: position.weekAdjustment,
      // ⭐ (Q1) The week contract (avalanche-core `glossary.ts`): "Counts toward
      // plan" (known), "Unconfirmed" (unresolved), whether the known comparison
      // is provisional, and what is left of the cap against KNOWN purchases
      // (null when no plan is set). The same call as GET /money/period-breakdown's
      // current week (`evidenceSplitCents`); `remainingWeek` above stays cautious.
      knownWeek: position.knownWeek,
      unresolvedWeek: position.unresolvedWeek,
      provisional: position.provisional,
      remainingWeekKnown: position.remainingWeekKnown,
    },
    // ⭐ (Q1) Can the bank balance be trusted? `readBankConfidence`
    // (lib/bankConfidence.ts): when the bank last told us anything, the bank's
    // own figure beside H2's, the last Sync's check of the two (= GET
    // /banking/review .balanceCheck for the forecast account) and the pending
    // rows the balance counts (= its .cashFlow.pendingCount). A dashboard says
    // "Matches bank" only from `check`, never from the review count. ⚠️ The
    // household's own cash, like `bank`: never a debt, a limit or credit.
    bankConfidence,
    // ⭐ (S3) This month's monthly allowance: plan (null when not set — never
    // "0.00"), what counts against it, and a status word; (S6) what is left and
    // how far over, so no screen subtracts. The same read and helpers as GET
    // /money/period-breakdown?period=month. ⚠️ Never a debt balance, credit or
    // a limit.
    monthAllowance,
  });
});

export default router;
