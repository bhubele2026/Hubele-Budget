// ⭐ (AVAL-W) "WE PAID IT" — the weekly avalanche, marked paid from the home
// page or the Debt page, and its exact undo.
//
// Owner, 2026-11-10: "on the home page I want a box that says which avalanche we
// are paying, when and a button to say we did" — and the button closes the
// week AND lowers that card's balance, with an Undo.
//
// THE PAY (`payAvalancheWeek`), in ONE transaction:
//   1. the week's answer, `avalanche:extra | date | matched`, written by the same
//      function POST /forecast/resolutions uses (`writeForecastResolution`),
//      keeping the answers it replaced;
//   2. each debt the week pays: a manual debt is lowered by its amount through
//      the same write POST /debts/:id/payments makes (`applyDebtPayment`: the
//      claim transaction, the balance, archived at $0) plus the day's history
//      row; a debt the bank carries (`plaid_account_id`) gets NO balance write —
//      the bank's next balance would overwrite it — and no claim;
//   3. one `avalanche_week_payments` record of all of it, for the undo.
// Then, as the debt route does after its transaction: the claims are paired
// with any bank row already in (best effort) and the debt budget lines synced.
//
// THE UNDO (`undoAvalancheWeekPay`), in ONE transaction, or nothing: deletes the
// answer and restores the answers it replaced (same ids), deletes the claims,
// and puts each manual debt's balance, status, as-of and history day back.
// Refused (nothing written) when the record is already undone, its week is more
// than `PAY_UNDO_DAYS` ago, or a manual debt's balance or the week's answer
// changed since.
//
// Every figure is the plan's (`loadWeeklyAvalanchePlan`, the plan the forecast
// puts on the curve) or the stored balance: nothing here prices a payment.

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  avalancheSettingsTable,
  avalancheWeekPaymentsTable,
  debtBalanceHistoryTable,
  debtsTable,
  forecastResolutionsTable,
  transactionsTable,
  type AvalancheWeekPayment,
  type AvalancheWeekPaymentDebt,
} from "@workspace/db";
import { round2 } from "@workspace/avalanche-core";
import type { Exec } from "./categorizer/db";
import { cadenceOf, loadWeeklyAvalanchePlan, SETTLING_ANSWERS } from "./avalancheWeeklyPlan";
import { AVALANCHE_EXTRA_EVENT_ITEM_ID } from "./debtMinSchedule";
import { applyDebtPayment } from "./debtPaymentApply";
import { recordBalanceSnapshot } from "./debtLiabilityApply";
import { confirmDebtPaymentClaims } from "./debtPaymentConfirm";
import { syncDebtBudgetAfterWrite } from "./budgetDebtSync";
import {
  undoForecastResolution,
  writeForecastResolution,
  type ForecastResolutionRow,
} from "./forecastResolutionWrite";
import { addDaysISO, householdTodayISO } from "./householdClock";
import { bumpLedgerGeneration } from "./ledgerShare";
import { logger } from "./logger";

/** An Undo is offered (and accepted) while the week's day is no more than this many days ago. */
export const PAY_UNDO_DAYS = 14;

/** The note on each claim the pay writes, so the row says where it came from. */
export const WEEK_PAY_NOTE = "Weekly avalanche payment";

export type WeekPayRefusalCode =
  | "invalid_date"
  | "not_weekly"
  | "unknown_week"
  | "already_answered"
  | "nothing_due"
  | "not_found"
  | "already_undone"
  | "too_late"
  | "changed_since";

const WORDS: Record<WeekPayRefusalCode, string> = {
  invalid_date: "Say which payment day (YYYY-MM-DD). Nothing was changed.",
  not_weekly: "The avalanche is paid monthly, so there is no week to mark paid. Nothing was changed.",
  unknown_week: "That day is not a payment day in this week's plan. Nothing was changed.",
  already_answered: "This week is already answered. Nothing was changed.",
  nothing_due: "Nothing is due this week. Nothing was changed.",
  not_found: "This payment is no longer there. Nothing was changed.",
  already_undone: "This payment was already undone. Nothing was changed.",
  too_late: `A payment can be undone for ${PAY_UNDO_DAYS} days after its week. Nothing was changed.`,
  changed_since: "A balance or this week's answer changed since. Nothing was changed.",
};

/** A refused pay or undo: the route answers `status` with `body()`. Nothing was written. */
export class WeekPayRefusal extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: WeekPayRefusalCode,
  ) {
    super(WORDS[code]);
  }
  body(): { error: string; code: WeekPayRefusalCode } {
    return { error: this.message, code: this.code };
  }
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cents = (v: string | number | null | undefined): number => Math.round((Number(v) || 0) * 100);

export type WeekPaidTargetView = { debtId: string; name: string; amount: number; linked: boolean; paidOff: boolean };

export type WeekPaymentView = {
  id: string;
  date: string;
  total: number;
  targets: WeekPaidTargetView[];
  createdBy: string;
  createdAt: string;
  undoneAt: string | null;
  undoable: boolean;
};

export type LastPaidView = Pick<WeekPaymentView, "id" | "date" | "total" | "targets" | "undoable">;

const debtsOf = (r: AvalancheWeekPayment): AvalancheWeekPaymentDebt[] => (r.debts as AvalancheWeekPaymentDebt[]) ?? [];

function targetsOf(r: AvalancheWeekPayment): WeekPaidTargetView[] {
  return debtsOf(r).map((d) => ({ debtId: d.debtId, name: d.name, amount: d.amount, linked: d.linked, paidOff: d.paidOff }));
}

function view(r: AvalancheWeekPayment, undoable: boolean): WeekPaymentView {
  return {
    id: r.id,
    date: r.weekDate,
    total: round2(Number(r.total) || 0),
    targets: targetsOf(r),
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    undoneAt: r.undoneAt ? r.undoneAt.toISOString() : null,
    undoable,
  };
}

/** The oldest week day an undo still reaches, on the household's calendar. */
const undoFloor = (): string => addDaysISO(householdTodayISO(), -PAY_UNDO_DAYS);

/**
 * What stops an undo of `r` now, read and not written: already undone, too
 * old, or something it wrote changed (a manual debt's balance, the week's
 * answer). Null when the undo would go through. The undo passes its
 * transaction and `lock` to read the debts under its row locks.
 */
async function undoBlocker(
  exec: Exec,
  householdId: string,
  r: AvalancheWeekPayment,
  opts: { lock?: boolean } = {},
): Promise<Exclude<WeekPayRefusalCode, "not_found"> | null> {
  if (r.undoneAt) return "already_undone";
  if (r.weekDate < undoFloor()) return "too_late";
  const manual = debtsOf(r).filter((d) => !d.linked);
  if (manual.length > 0) {
    const ids = manual.map((d) => d.debtId);
    const q = exec
      .select({ id: debtsTable.id, balance: debtsTable.balance })
      .from(debtsTable)
      .where(and(eq(debtsTable.householdId, householdId), inArray(debtsTable.id, ids)));
    const rows = opts.lock ? await q.for("update") : await q;
    const now = new Map(rows.map((x) => [x.id, x.balance] as const));
    for (const d of manual) {
      if (!now.has(d.debtId) || cents(now.get(d.debtId)) !== cents(d.balanceAfter)) return "changed_since";
    }
  }
  const [answer] = await exec
    .select({ id: forecastResolutionsTable.id, status: forecastResolutionsTable.status })
    .from(forecastResolutionsTable)
    .where(and(eq(forecastResolutionsTable.id, r.resolutionId), eq(forecastResolutionsTable.householdId, householdId)));
  if (!answer || answer.status !== "matched") return "changed_since";
  return null;
}

/**
 * The household's latest "We paid it" that is not undone, for
 * `GET /avalanche/weekly`'s `lastPaid`; null when there is none.
 */
export async function lastAvalanchePayment(householdId: string): Promise<LastPaidView | null> {
  const [r] = await db
    .select()
    .from(avalancheWeekPaymentsTable)
    .where(and(eq(avalancheWeekPaymentsTable.householdId, householdId), isNull(avalancheWeekPaymentsTable.undoneAt)))
    .orderBy(desc(avalancheWeekPaymentsTable.createdAt))
    .limit(1);
  if (!r) return null;
  const blocker = await undoBlocker(db, householdId, r);
  const v = view(r, blocker === null);
  return { id: v.id, date: v.date, total: v.total, targets: v.targets, undoable: v.undoable };
}

async function afterWrite(householdId: string, userId: string): Promise<void> {
  // A read that starts now never joins a forecast build that began before the write.
  bumpLedgerGeneration();
  await syncDebtBudgetAfterWrite(householdId, userId);
}

/**
 * ⭐ `POST /avalanche/weekly/pay` — close `date`'s week and lower each manual
 * debt it pays by its amount. Throws `WeekPayRefusal` (nothing written) when
 * the cadence is monthly, the day is not a payment day of the current plan, the
 * week is already answered (or paid), or it has nothing due.
 */
export async function payAvalancheWeek(
  householdId: string,
  ownerUserId: string,
  actorUserId: string,
  date: unknown,
): Promise<WeekPaymentView> {
  if (typeof date !== "string" || !ISO_DAY.test(date)) throw new WeekPayRefusal(400, "invalid_date");
  const [settings] = await db.select().from(avalancheSettingsTable).where(eq(avalancheSettingsTable.userId, ownerUserId));
  if (cadenceOf(settings).cadence !== "weekly") throw new WeekPayRefusal(409, "not_weekly");
  const plan = await loadWeeklyAvalanchePlan(householdId, ownerUserId);
  if (!plan) throw new WeekPayRefusal(409, "not_weekly");
  const week = plan.weeks.find((w) => w.date === date);
  if (!week) throw new WeekPayRefusal(400, "unknown_week");
  if (week.answered) throw new WeekPayRefusal(409, "already_answered");
  if (!(week.due > 0) || week.targets.length === 0) throw new WeekPayRefusal(409, "nothing_due");
  const targets = week.targets.map((t) => ({ debtId: t.debtId, name: t.name, amount: round2(t.amount), paidOff: t.paidOff }));
  const today = householdTodayISO();

  const record = await db.transaction(async (tx) => {
    // One press at a time per household: two taps (or two people) never both pay.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`aval-week-pay:${householdId}`}::text))`);
    const [settled] = await tx
      .select({ id: forecastResolutionsTable.id })
      .from(forecastResolutionsTable)
      .where(
        and(
          eq(forecastResolutionsTable.householdId, householdId),
          eq(forecastResolutionsTable.recurringItemId, AVALANCHE_EXTRA_EVENT_ITEM_ID),
          eq(forecastResolutionsTable.occurrenceDate, date),
          inArray(forecastResolutionsTable.status, [...SETTLING_ANSWERS]),
        ),
      )
      .limit(1);
    const [live] = await tx
      .select({ id: avalancheWeekPaymentsTable.id })
      .from(avalancheWeekPaymentsTable)
      .where(
        and(
          eq(avalancheWeekPaymentsTable.householdId, householdId),
          eq(avalancheWeekPaymentsTable.weekDate, date),
          isNull(avalancheWeekPaymentsTable.undoneAt),
        ),
      )
      .limit(1);
    if (settled || live) throw new WeekPayRefusal(409, "already_answered");

    const rows = await tx
      .select()
      .from(debtsTable)
      .where(and(eq(debtsTable.householdId, householdId), inArray(debtsTable.id, targets.map((t) => t.debtId))))
      .for("update");
    const byId = new Map(rows.map((d) => [d.id, d] as const));

    const debts: AvalancheWeekPaymentDebt[] = [];
    for (const t of targets) {
      const debt = byId.get(t.debtId);
      if (!debt) throw new WeekPayRefusal(409, "changed_since");
      const base = { debtId: t.debtId, name: t.name, amount: t.amount, balanceBefore: debt.balance, statusBefore: debt.status };
      if (debt.plaidAccountId) {
        // The bank carries this balance: a manual write would be overwritten by its next refresh.
        debts.push({
          ...base,
          linked: true,
          balanceAfter: null,
          statusAfter: null,
          lastBalanceUpdateBefore: debt.lastBalanceUpdate ? debt.lastBalanceUpdate.toISOString() : null,
          snapshotDay: null,
          snapshotBefore: null,
          claimTxnId: null,
          paidOff: t.paidOff,
        });
        continue;
      }
      const [history] = await tx
        .select({ balance: debtBalanceHistoryTable.balance })
        .from(debtBalanceHistoryTable)
        .where(
          and(
            eq(debtBalanceHistoryTable.householdId, householdId),
            eq(debtBalanceHistoryTable.debtId, t.debtId),
            eq(debtBalanceHistoryTable.recordedOn, today),
          ),
        );
      const paid = await applyDebtPayment(tx, {
        userId: actorUserId,
        householdId,
        debtId: t.debtId,
        amount: t.amount,
        occurredOn: today,
        notes: WEEK_PAY_NOTE,
      });
      if (!paid) throw new WeekPayRefusal(409, "changed_since");
      await recordBalanceSnapshot(actorUserId, householdId, t.debtId, paid.debt.balance, tx);
      debts.push({
        ...base,
        balanceBefore: paid.before.balance,
        statusBefore: paid.before.status,
        linked: false,
        balanceAfter: paid.debt.balance,
        statusAfter: paid.debt.status,
        lastBalanceUpdateBefore: paid.before.lastBalanceUpdate ? paid.before.lastBalanceUpdate.toISOString() : null,
        snapshotDay: today,
        snapshotBefore: history ? history.balance : null,
        claimTxnId: paid.transaction.id,
        paidOff: paid.killed,
      });
    }

    const { row: answer, deleted } = await writeForecastResolution(tx, {
      userId: actorUserId,
      householdId,
      recurringItemId: AVALANCHE_EXTRA_EVENT_ITEM_ID,
      occurrenceDate: date,
      status: "matched",
    });
    const total = round2(targets.reduce((s, t) => s + t.amount, 0));
    const [inserted] = await tx
      .insert(avalancheWeekPaymentsTable)
      .values({
        householdId,
        weekDate: date,
        total: total.toFixed(2),
        resolutionId: answer.id,
        replaced: deleted,
        debts,
        createdBy: actorUserId,
      })
      .returning();
    return inserted!;
  });

  // (PR-D) As the debt route does: a bank row already in may confirm a claim now. Best effort.
  if (debtsOf(record).some((d) => d.claimTxnId)) {
    try {
      await confirmDebtPaymentClaims(householdId);
    } catch (err) {
      logger.warn({ err, householdId }, "[avalanche-week-pay] claim confirmation after payment failed");
    }
  }
  await afterWrite(householdId, actorUserId);
  return view(record, (await undoBlocker(db, householdId, record)) === null);
}

const resolutionFromJson = (r: ForecastResolutionRow): ForecastResolutionRow => ({ ...r, createdAt: new Date(String(r.createdAt)) });

/**
 * ⭐ `POST /avalanche/weekly/pay/:id/undo` — the whole payment, exactly, or
 * nothing. Throws `WeekPayRefusal` (nothing written): `not_found`,
 * `already_undone`, `too_late` or `changed_since`.
 */
export async function undoAvalancheWeekPay(householdId: string, actorUserId: string, id: string): Promise<WeekPaymentView> {
  if (!UUID_RE.test(id)) throw new WeekPayRefusal(404, "not_found");
  const record = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`aval-week-pay:${householdId}`}::text))`);
    const [r] = await tx
      .select()
      .from(avalancheWeekPaymentsTable)
      .where(and(eq(avalancheWeekPaymentsTable.id, id), eq(avalancheWeekPaymentsTable.householdId, householdId)))
      .for("update");
    if (!r) throw new WeekPayRefusal(404, "not_found");
    const blocker = await undoBlocker(tx, householdId, r, { lock: true });
    if (blocker) throw new WeekPayRefusal(409, blocker);

    // The answer, and the answers it replaced (same ids, same fields).
    const replaced = ((r.replaced as ForecastResolutionRow[]) ?? []).map(resolutionFromJson);
    const out = await undoForecastResolution(tx, householdId, r.resolutionId, replaced);
    if (!out.ok) throw new WeekPayRefusal(409, "changed_since");

    // Each manual debt: its claim, its balance, status and as-of, its day of history.
    for (const d of debtsOf(r)) {
      if (d.linked) continue;
      if (d.claimTxnId) {
        await tx
          .delete(transactionsTable)
          .where(and(eq(transactionsTable.id, d.claimTxnId), eq(transactionsTable.householdId, householdId)));
      }
      await tx
        .update(debtsTable)
        .set({
          balance: d.balanceBefore,
          status: d.statusBefore,
          lastBalanceUpdate: d.lastBalanceUpdateBefore ? new Date(d.lastBalanceUpdateBefore) : null,
          updatedAt: new Date(),
        })
        .where(and(eq(debtsTable.id, d.debtId), eq(debtsTable.householdId, householdId)));
      if (d.snapshotDay) {
        const day = and(
          eq(debtBalanceHistoryTable.householdId, householdId),
          eq(debtBalanceHistoryTable.debtId, d.debtId),
          eq(debtBalanceHistoryTable.recordedOn, d.snapshotDay),
        );
        if (d.snapshotBefore === null) await tx.delete(debtBalanceHistoryTable).where(day);
        else await tx.update(debtBalanceHistoryTable).set({ balance: d.snapshotBefore }).where(day);
      }
    }

    const [undone] = await tx
      .update(avalancheWeekPaymentsTable)
      .set({ undoneAt: new Date(), undoneBy: actorUserId })
      .where(and(eq(avalancheWeekPaymentsTable.id, r.id), eq(avalancheWeekPaymentsTable.householdId, householdId)))
      .returning();
    return undone!;
  });
  await afterWrite(householdId, actorUserId);
  return view(record, false);
}
