import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lt, lte } from "drizzle-orm";
import {
  db,
  debtBalanceHistoryTable,
  debtLedgerEventsTable,
  debtMilestonesTable,
  debtProgressSnapshotsTable,
  debtsTable,
  transactionsTable,
} from "@workspace/db";
import {
  addDaysISO,
  CENTS,
  decomposeDelta,
  effectiveDebtBalance,
  isCardDebt,
  pairTransfers,
  PERCENT_MILESTONES,
  payoffPct,
  type DebtEvent,
  type TransferCandidate,
} from "@workspace/avalanche-core";
import { withPendingPayments } from "./debtPending";

/**
 * (PR-D) ONE ROW PER DEBT PER DAY: the balance, and what moved it since that
 * debt's previous snapshot (or since the day before, for its first).
 *
 *   - the balance is `debt_balance_history` as of the day (the latest recorded
 *     on or before it) — the balance the app held that day;
 *   - the causes are the liability ledger's events in the window
 *     (`debt_ledger_events`) — for a debt with its own feed — or, for a debt
 *     with none (a manual debt), the CONFIRMED claims against it: the payment
 *     logged in the app that lowered the balance, once a bank row confirmed it.
 *     Never both, so one payment is never counted from both sides;
 *   - a payment that is half of a transfer pair (`pairTransfers`, against
 *     charges on the household's OTHER debts within ±5 days) is still a
 *     payment for this debt's identity, and is marked so it never counts as
 *     genuine progress.
 *
 * `decomposeDelta` makes the six columns sum to `delta` to the cent; whatever
 * the events do not explain lands in `unexplained` (an unconfirmed claim, a
 * creditor balance that moved before its rows arrived, a manual edit).
 *
 * Idempotent: an upsert on (debt_id, as_of) — re-running a day rewrites the
 * same row. The nightly job (jobs package) calls this; until then,
 * `POST /debt-plan/snapshot` does.
 */
export async function writeDebtProgressSnapshots(
  householdId: string,
  asOfDay: string,
): Promise<{ written: number }> {
  const debts = await db.select().from(debtsTable).where(eq(debtsTable.householdId, householdId));
  if (debts.length === 0) return { written: 0 };
  const ids = debts.map((d) => d.id);

  const [history, prevSnaps, feedDebtRows] = await Promise.all([
    db
      .select({
        debtId: debtBalanceHistoryTable.debtId,
        recordedOn: debtBalanceHistoryTable.recordedOn,
        balance: debtBalanceHistoryTable.balance,
      })
      .from(debtBalanceHistoryTable)
      .where(
        and(
          eq(debtBalanceHistoryTable.householdId, householdId),
          inArray(debtBalanceHistoryTable.debtId, ids),
          lte(debtBalanceHistoryTable.recordedOn, asOfDay),
        ),
      )
      .orderBy(asc(debtBalanceHistoryTable.recordedOn)),
    db
      .select({ debtId: debtProgressSnapshotsTable.debtId, asOf: debtProgressSnapshotsTable.asOf })
      .from(debtProgressSnapshotsTable)
      .where(
        and(
          eq(debtProgressSnapshotsTable.householdId, householdId),
          lt(debtProgressSnapshotsTable.asOf, asOfDay),
        ),
      )
      .orderBy(desc(debtProgressSnapshotsTable.asOf)),
    db
      .selectDistinct({ debtId: debtLedgerEventsTable.debtId })
      .from(debtLedgerEventsTable)
      .where(eq(debtLedgerEventsTable.householdId, householdId)),
  ]);
  const prevDayOf = new Map<string, string>();
  for (const s of prevSnaps) if (!prevDayOf.has(s.debtId)) prevDayOf.set(s.debtId, s.asOf);
  const hasFeed = new Set(feedDebtRows.map((r) => r.debtId));
  const balanceAsOf = (debtId: string, day: string): number | null => {
    let out: number | null = null;
    for (const h of history) if (h.debtId === debtId && h.recordedOn <= day) out = Number(h.balance) || 0;
    return out;
  };

  // The widest window any debt needs, ±5 days for the transfer pairing.
  const windowStart = [...ids.map((id) => prevDayOf.get(id) ?? addDaysISO(asOfDay, -1))].sort()[0]!;
  const [events, claims] = await Promise.all([
    db
      .select()
      .from(debtLedgerEventsTable)
      .where(
        and(
          eq(debtLedgerEventsTable.householdId, householdId),
          gte(debtLedgerEventsTable.occurredOn, addDaysISO(windowStart, -5)),
          lte(debtLedgerEventsTable.occurredOn, addDaysISO(asOfDay, 5)),
        ),
      ),
    db
      .select({
        id: transactionsTable.id,
        debtId: transactionsTable.debtId,
        occurredOn: transactionsTable.occurredOn,
        amount: transactionsTable.amount,
      })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.householdId, householdId),
          eq(transactionsTable.paymentState, "confirmed"),
          isNotNull(transactionsTable.confirmedByTxnId),
          gt(transactionsTable.occurredOn, windowStart),
          lte(transactionsTable.occurredOn, asOfDay),
        ),
      ),
  ]);

  // Payments (both sources) against every debt's charges: one pairing for the household.
  const paymentCands: TransferCandidate[] = [];
  for (const e of events) {
    if (e.kind === "payment" && hasFeed.has(e.debtId)) {
      paymentCands.push({ id: `e:${e.id}`, debtId: e.debtId, amount: Number(e.amount), occurredOn: e.occurredOn });
    }
  }
  for (const c of claims) {
    if (c.debtId && !hasFeed.has(c.debtId)) {
      paymentCands.push({ id: `c:${c.id}`, debtId: c.debtId, amount: Math.abs(Number(c.amount)), occurredOn: c.occurredOn });
    }
  }
  const chargeCands: TransferCandidate[] = events
    .filter((e) => e.kind === "charge")
    .map((e) => ({ id: `e:${e.id}`, debtId: e.debtId, amount: Number(e.amount), occurredOn: e.occurredOn }));
  const paired = pairTransfers(paymentCands, chargeCands);
  const pairedCharges = new Set(paired.values());
  const txnOfCandidate = new Map<string, string | null>();
  for (const e of events) txnOfCandidate.set(`e:${e.id}`, e.transactionId);
  for (const c of claims) txnOfCandidate.set(`c:${c.id}`, c.id);

  let written = 0;
  for (const d of debts) {
    const after = balanceAsOf(d.id, asOfDay);
    if (after === null) continue;
    const prevDay = prevDayOf.get(d.id) ?? addDaysISO(asOfDay, -1);
    const before = balanceAsOf(d.id, prevDay) ?? after;
    const inWindow = (day: string) => day > prevDay && day <= asOfDay;
    const evs: DebtEvent[] = [];
    let transferTxn: string | null = null;
    if (hasFeed.has(d.id)) {
      for (const e of events) {
        if (e.debtId !== d.id || !inWindow(e.occurredOn)) continue;
        const key = `e:${e.id}`;
        const transferPair = e.kind === "payment" ? paired.has(key) : e.kind === "charge" && pairedCharges.has(key);
        if (transferPair && e.kind === "payment" && !transferTxn) transferTxn = txnOfCandidate.get(paired.get(key)!) ?? null;
        evs.push({ kind: e.kind as DebtEvent["kind"], amount: Number(e.amount), transferPair });
      }
    } else {
      for (const c of claims) {
        if (c.debtId !== d.id || !inWindow(c.occurredOn)) continue;
        const key = `c:${c.id}`;
        const transferPair = paired.has(key);
        if (transferPair && !transferTxn) transferTxn = txnOfCandidate.get(paired.get(key)!) ?? null;
        evs.push({ kind: "payment", amount: Math.abs(Number(c.amount)), transferPair });
      }
    }
    const x = decomposeDelta({ balanceBefore: before, balanceAfter: after, events: evs });
    const row = {
      householdId,
      debtId: d.id,
      asOf: asOfDay,
      balanceEffective: after.toFixed(2),
      delta: x.delta.toFixed(2),
      paymentsConfirmed: x.paymentsConfirmed.toFixed(2),
      interest: x.interest.toFixed(2),
      fees: x.fees.toFixed(2),
      newCharges: x.newCharges.toFixed(2),
      credits: x.credits.toFixed(2),
      unexplained: x.unexplained.toFixed(2),
      transferPairTxnId: transferTxn,
    };
    await db
      .insert(debtProgressSnapshotsTable)
      .values(row)
      .onConflictDoUpdate({
        target: [debtProgressSnapshotsTable.debtId, debtProgressSnapshotsTable.asOf],
        set: {
          balanceEffective: row.balanceEffective,
          delta: row.delta,
          paymentsConfirmed: row.paymentsConfirmed,
          interest: row.interest,
          fees: row.fees,
          newCharges: row.newCharges,
          credits: row.credits,
          unexplained: row.unexplained,
          transferPairTxnId: row.transferPairTxnId,
        },
      });
    written += 1;
  }
  return { written };
}

/**
 * (PR-D) Record the milestones the household has REACHED as of `asOfDay`.
 * INSERT-ONLY (`ON CONFLICT DO NOTHING`): a milestone is history, so a balance
 * that ticks back up never removes one, and a re-run inserts nothing new.
 *
 *   - `pct_25` … `pct_100`: `payoffPct` — the landing's own "% paid", netted —
 *     at or past the step;
 *   - `debt_zero:<id>`: a debt that carried an anchor and whose netted balance
 *     is $0;
 *   - `first_card_zero`: the first credit card found at $0 (by name order when
 *     several reach it on the same run).
 */
export async function writeAchievedMilestones(
  householdId: string,
  asOfDay: string,
): Promise<{ inserted: string[] }> {
  const rows = await db.select().from(debtsTable).where(eq(debtsTable.householdId, householdId));
  if (rows.length === 0) return { inserted: [] };
  const netted = await withPendingPayments(householdId, rows);
  const pct = payoffPct(netted);
  const values: Array<typeof debtMilestonesTable.$inferInsert> = [];
  if (pct !== null) {
    for (const { step, key, label } of PERCENT_MILESTONES) {
      if (pct >= step - 1e-9) {
        values.push({
          householdId,
          key,
          label,
          achievedOn: asOfDay,
          evidence: { payoffPct: Math.round(pct * 100) / 100 },
        });
      }
    }
  }
  const zero = netted
    .filter((d) => Number(d.originalBalance ?? 0) > 0 && effectiveDebtBalance(d) <= CENTS)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  for (const d of zero) {
    values.push({
      householdId,
      debtId: d.id,
      key: `debt_zero:${d.id}`,
      label: `${d.name} paid off`,
      achievedOn: asOfDay,
      evidence: { debtId: d.id },
    });
  }
  const firstCard = zero.find((d) => isCardDebt(d));
  if (firstCard) {
    values.push({
      householdId,
      debtId: firstCard.id,
      key: "first_card_zero",
      label: "First card at $0",
      achievedOn: asOfDay,
      evidence: { debtId: firstCard.id },
    });
  }
  if (values.length === 0) return { inserted: [] };
  const inserted = await db
    .insert(debtMilestonesTable)
    .values(values)
    .onConflictDoNothing({ target: [debtMilestonesTable.householdId, debtMilestonesTable.key] })
    .returning({ key: debtMilestonesTable.key });
  return { inserted: inserted.map((r) => r.key) };
}
