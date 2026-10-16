import { Router, type IRouter } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { db, forecastSettingsTable, plaidAccountsTable, plaidItemsTable, transactionsTable } from "@workspace/db";
import { BANK_CHECK_MAX_IDS, sameAnchorMoment } from "@workspace/avalanche-core";
import { requireAuth } from "../middlewares/requireAuth";
import { resolveLedgerScope } from "../lib/bankLedger";
import { readBankBalanceCheck, readBankCheckLedger, type BankCheckLedgerRead } from "../lib/bankBalanceCheck";
import { presentBalanceCheck } from "../lib/bankingReview";
import { dataAsOfOf } from "../lib/dataAsOf";
import { householdDayOf, householdTodayISO } from "../lib/householdClock";

/**
 * ⭐ (T2) "REVIEW DIFFERENCE" — what H2 can and cannot explain about the last
 * balance check (`GET /banking/check-explain`).
 *
 * The owner's case: a Sync read the bank at $0.00, H2 expected $432.00 from the
 * previous reading, and the same Sync re-anchored H2 to the bank — so today the
 * two agree while the check stays "off by $432.00". "Why this number?" explains
 * today's balance; this explains THE CHECK: the stored record (previous reading,
 * the bank's figure, what H2 expected), the bank rows the check counted between
 * the two readings, the deposits its rules left out or added, the rows H2
 * recorded itself (counted in H2's balance, left out of the check — PR4e), the
 * rows that arrived after it, today's two figures, and a plain verdict:
 *
 *   late_rows_tie      the check is resolved_since (late rows explain it);
 *   manual_rows_match  the rows H2 recorded itself add up to the difference;
 *   unknown            nothing H2 holds explains it;
 *   null               there is no difference to explain.
 *
 * ⚠️ READ-ONLY AND FREE: no Plaid call, no write. The record is never cleared or
 * changed here (`lib/bankBalanceCheck.ts` is untouched); the check itself is the
 * review's (`readBankBalanceCheck` + `presentBalanceCheck`), and the rows come
 * from the check's own recompute (`readBankCheckLedger`, the same call the review
 * makes). Every figure is the record's, the ledger's or a sum of the ledger's own
 * contributions — nothing new is derived.
 */
const router: IRouter = Router();

const round2 = (n: number): number => Math.round(n * 100) / 100;
const money = (n: number): string => round2(n).toFixed(2);
const toNum = (v: string | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

type RowOut = { id: string; date: string; description: string | null; amount: string; pending: boolean; source: string | null };

router.get("/banking/check-explain", requireAuth, async (req, res): Promise<void> => {
  const householdId = req.householdId!;
  const ownerUserId = req.householdOwnerId!;
  const now = new Date();

  // The forecast checking account's scope (its twins, today's balance, the reading under it) — the review's default.
  const [scope, [settings]] = await Promise.all([
    resolveLedgerScope(householdId, ownerUserId, undefined),
    db
      .select({ record: forecastSettingsTable.lastBankReconciliation, anchorAt: forecastSettingsTable.bankSnapshotAt })
      .from(forecastSettingsTable)
      .where(eq(forecastSettingsTable.userId, ownerUserId)),
  ]);
  const rec = settings?.record ?? null;
  const applies = !!rec && scope.snapshotAccount && scope.plaidAccountIds.includes(rec.accountId);
  const currentAnchorAt = settings?.anchorAt ?? null;

  // The check, exactly as the review answers it (one recompute query at most, no Plaid call).
  const check = presentBalanceCheck(
    await readBankBalanceCheck({
      householdId,
      record: rec,
      isForecastAccount: scope.snapshotAccount,
      accountIds: scope.plaidAccountIds,
      currentAnchorAt,
      now,
    }),
  );

  // The check's own rows: the recompute the review runs, under the same conditions.
  let ledger: BankCheckLedgerRead | null = null;
  if (
    applies &&
    rec &&
    (rec.status === "ties" || rec.status === "drift") &&
    rec.prevAnchor &&
    rec.bank &&
    (rec.bank.field !== "available" || rec.pendingDeposits != null)
  ) {
    const checkAt = new Date(rec.checkedAt);
    const prevPending = rec.prevAnchor.pendingDepositIds;
    ledger = await readBankCheckLedger({
      householdId,
      accountExternalId: rec.accountId,
      prevAnchor: { balance: Number(rec.prevAnchor.balance), at: new Date(rec.prevAnchor.at) },
      checkDay: householdDayOf(checkAt),
      checkAt,
      bankField: rec.bank.field,
      excludedIds: new Set(rec.pendingDeposits?.ids ?? []),
      anchorPendingDepositIds: prevPending ? new Set(prevPending) : null,
      addedIds: new Set(rec.added?.ids ?? []),
      todayISO: householdTodayISO(now),
    });
  }

  const countedAtCheck = ledger ? ledger.counted.filter((c) => !c.late) : [];
  const arrivedSince = ledger ? ledger.counted.filter((c) => c.late) : [];
  const excludedIds = applies ? (rec?.excluded?.ids ?? []) : [];
  const addedIds = applies ? (rec?.added?.ids ?? []) : [];
  const manualIds = ledger ? ledger.manual.ids : [];
  const cap = <T,>(xs: T[]): T[] => xs.slice(0, BANK_CHECK_MAX_IDS);

  // One query for every row named above (each list capped).
  const wanted = Array.from(
    new Set([
      ...cap(countedAtCheck.map((c) => c.id)),
      ...cap(arrivedSince.map((c) => c.id)),
      ...cap(excludedIds),
      ...cap(addedIds),
      ...cap(manualIds),
    ]),
  );
  const t = transactionsTable;
  const found =
    wanted.length > 0
      ? await db
          .select({ id: t.id, occurredOn: t.occurredOn, description: t.description, amount: t.amount, pending: t.pending, source: t.source })
          .from(t)
          .where(and(eq(t.householdId, householdId), inArray(t.id, wanted)))
      : [];
  const byId = new Map(found.map((r) => [r.id, r] as const));
  // A row deleted since the check is dropped, never invented; the list's own order is kept.
  const rowsOf = (ids: readonly string[]): RowOut[] =>
    cap([...ids]).flatMap((id) => {
      const r = byId.get(id);
      return r
        ? [{ id, date: r.occurredOn, description: r.description ?? null, amount: money(Number(r.amount)), pending: r.pending === true, source: r.source ?? null }]
        : [];
    });

  const countedNet = round2(countedAtCheck.reduce((a, c) => a + c.contribution, 0));
  const prev = toNum(rec?.prevAnchor?.balance);
  const predicted = toNum(rec?.predicted);
  const addedAmount = toNum(rec?.added?.amount) ?? 0;
  const manualAmount = ledger ? round2(ledger.manual.amount) : 0;
  const unexplained = toNum(rec?.unexplained);

  // The plain verdict: code arithmetic over the record and the lists, nothing more.
  const verdict: "late_rows_tie" | "manual_rows_match" | "unknown" | null = !applies
    ? null
    : check.status === "resolved_since"
      ? "late_rows_tie"
      : check.status !== "off_by"
        ? null
        : manualIds.length > 0 && unexplained != null && Math.round(manualAmount * 100) === Math.round(unexplained * 100)
          ? "manual_rows_match"
          : "unknown";

  // The checked account, named.
  const [acct] = applies
    ? await db
        .select({ name: plaidAccountsTable.name, mask: plaidAccountsTable.mask, institution: plaidItemsTable.institutionName })
        .from(plaidAccountsTable)
        .leftJoin(plaidItemsTable, eq(plaidItemsTable.id, plaidAccountsTable.itemId))
        .where(and(eq(plaidAccountsTable.householdId, householdId), eq(plaidAccountsTable.accountId, rec!.accountId)))
    : [];

  const checkedAnchorAt = rec?.anchor?.at ?? rec?.bank?.at ?? null;
  const h2Today = scope.anchor.todayBalance;
  const readingToday = h2Today == null ? null : scope.anchor.snapshotBalance;

  res.json({
    dataAsOf: dataAsOfOf(scope.anchor.snapshotAt, now),
    account: {
      externalId: applies ? rec!.accountId : null,
      institution: acct?.institution ?? null,
      name: acct?.name ?? null,
      mask: acct?.mask ?? null,
    },
    check,
    record:
      applies && rec
        ? {
            checkedAt: rec.checkedAt,
            status: rec.status,
            reason: rec.reason ?? null,
            prevAnchor: rec.prevAnchor
              ? { balance: rec.prevAnchor.balance, at: rec.prevAnchor.at, field: rec.prevAnchor.field ?? null }
              : null,
            bank: rec.bank ? { balance: rec.bank.balance, at: rec.bank.at, field: rec.bank.field } : null,
            anchor: rec.anchor ? { balance: rec.anchor.balance, at: rec.anchor.at, field: rec.anchor.field } : null,
            predicted: rec.predicted ?? null,
            unexplained: rec.unexplained,
            fieldChanged: rec.fieldChanged === true,
          }
        : null,
    counted: {
      listed: ledger != null,
      rowCount: countedAtCheck.length,
      net: money(countedNet),
      // The record's own figure is the previous reading + these rows + the deposits added (rule 2).
      addsUp:
        ledger != null && prev != null && predicted != null
          ? Math.round((prev + countedNet + addedAmount) * 100) === Math.round(predicted * 100)
          : null,
      rows: rowsOf(countedAtCheck.map((c) => c.id)),
    },
    excluded: { amount: applies ? (rec?.excluded?.amount ?? null) : null, rows: rowsOf(excludedIds) },
    added: { amount: applies ? (rec?.added?.amount ?? null) : null, rows: rowsOf(addedIds) },
    manualRows: { amount: ledger ? money(manualAmount) : null, rows: rowsOf(manualIds) },
    rowsSince: { count: arrivedSince.length, rows: rowsOf(arrivedSince.map((c) => c.id)) },
    today: {
      h2Balance: h2Today,
      bankReading: readingToday,
      bankAsOf: scope.anchor.snapshotAt,
      // The check's bank reading is the anchor H2 starts from now.
      sameMoment: checkedAnchorAt != null && sameAnchorMoment(checkedAnchorAt, scope.anchor.snapshotAt),
    },
    verdict,
  });
});

export default router;
