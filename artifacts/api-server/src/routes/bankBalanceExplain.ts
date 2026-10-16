import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { computeCashSignal } from "../lib/cashSignal";
import { resolveSnapshotAccount } from "../lib/resolveSnapshotAccount";
import { householdDayOf, householdTodayISO } from "../lib/householdClock";
import { bankFetchedAt, computeBankFreshness } from "../lib/bankFreshness";
import { classifyLedgerRowsThroughToday } from "../lib/ledgerCashRows";
import { dataAsOfOf } from "../lib/dataAsOf";
import { isBankRow, type CashRowReason } from "@workspace/avalanche-core";

const router: IRouter = Router();

/** (Task 4, D) One row the roll-forward read, with the cash rule's verdict on it (`BankBalanceExplainRow`). */
type ExplainRow = {
  id: string;
  date: string;
  description: string | null;
  /** Signed, as stored. */
  amount: string;
  pending: boolean;
  accountExternalId: string | null;
  source: string | null;
  /**
   * On the reading's account by the rule's own `isBankRow` (a manual row is the
   * account's own). The rule checks "held" first, so a card row dated before the
   * reading's day comes back `held`: this says it is another account's.
   */
  onAccount: boolean;
  /** The rule's `counts`: the row is in Checking today (it may add 0.00). */
  counted: boolean;
  /** What it adds to Checking today: 0.00 unless counted; for `adjusted`, posted − pending. */
  contribution: string;
  reason: CashRowReason;
  /** A posted row's pending half, when it replaced one. */
  replacedId: string | null;
};

/**
 * ⭐ WHY IS MY BANK BALANCE THIS NUMBER?
 *
 * Born 2026-08-25, out of a bad afternoon. Brad's Chase balance read $169.90
 * low on every screen. Diagnosing it needed three facts that live only in the
 * database and the server logs — what the anchor is, which account it resolves
 * to, and whether a Sync would even re-read it — and the only people who could
 * see any of that were people with production credentials. So the loop became:
 * guess, ship, ask him to press Sync, repeat. That is a terrible way to fix
 * someone's money.
 *
 * This endpoint ends that loop. It shows its work: the anchor, how the account
 * behind it resolved, whether the next Sync will refresh it (and if not, WHY
 * not), what the ledger has added since, and the rows it added. Open it in a
 * signed-in browser and the answer is on one screen.
 *
 * ⚠️ READ-ONLY AND FREE. No Plaid call, no writes. Everything here is already
 * in our own database — this endpoint only stops it from being invisible.
 */
router.get(
  "/forecast/bank-balance-explain",
  requireAuth,
  async (req, res): Promise<void> => {
    const householdId = req.householdId!;
    const ownerUserId = req.householdOwnerId!;

    const [settings] = await db
      .select()
      .from(forecastSettingsTable)
      .where(eq(forecastSettingsTable.userId, ownerUserId));

    const resolved = await resolveSnapshotAccount({
      householdId,
      bankSnapshotAccountId: settings?.bankSnapshotAccountId ?? null,
      bankSnapshotMask: settings?.bankSnapshotMask ?? null,
    });

    const items = await db
      .select({
        itemRowId: plaidItemsTable.id,
        institutionName: plaidItemsTable.institutionName,
        lastSyncedAt: plaidItemsTable.lastSyncedAt,
        lastSyncError: plaidItemsTable.lastSyncError,
        lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode,
      })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.householdId, householdId));

    const accounts = await db
      .select({
        rowId: plaidAccountsTable.id,
        externalId: plaidAccountsTable.accountId,
        itemId: plaidAccountsTable.itemId,
        name: plaidAccountsTable.name,
        mask: plaidAccountsTable.mask,
        type: plaidAccountsTable.type,
        subtype: plaidAccountsTable.subtype,
      })
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.householdId, householdId));

    const owningAccount = accounts.find((a) => a.rowId === resolved.rowId) ?? null;

    // ⚠️ THE ANSWER TO "I PRESSED SYNC AND NOTHING HAPPENED". These are the
    // exact conditions `plaidSync` applies before it re-reads the balance from
    // Plaid; when one is false the refresh is skipped and, until this endpoint
    // existed, skipped silently.
    const hasAnchor =
      settings?.bankSnapshotBalance != null ||
      settings?.bankSnapshotAccountId != null;
    let willRefresh = true;
    let whyNot: string | null = null;
    if (!hasAnchor) {
      willRefresh = false;
      whyNot =
        "no bank snapshot is set, so there is no anchor to refresh (the forecast runs off the starting balance)";
    } else if (!resolved.externalId) {
      willRefresh = false;
      whyNot =
        "the snapshot does not resolve to any Plaid account — its stored account is missing or was retired, and nothing else identifies it uniquely";
    } else if (!owningAccount) {
      willRefresh = false;
      whyNot = "the resolved account is no longer on file for this household";
    }

    // Household calendar days (America/Chicago), matching the roll-forward.
    const anchorDay = settings?.bankSnapshotAt
      ? householdDayOf(settings.bankSnapshotAt)
      : null;
    const todayDay = householdTodayISO();

    // What the roll-forward is adding on top of the anchor — the other half of
    // every figure on screen.
    //
    // ⭐ ONE RULE WITH THE BALANCE (PR4e). This used to sum the account's rows
    // dated after the snapshot day, which is not what `bankToday` adds: it
    // skipped manual rows and snapshot-day rows after the read, and added rows
    // the snapshot already held and both halves of a pending/posted pair. The
    // popover's "counted differently" note was routine. It now asks the ledger's
    // own rule (`classifyCashRows`) over the ledger's own rows, so the snapshot
    // plus `net` is `bankToday` to the cent.
    //   - Present whenever the snapshot has a read time — the ledger's condition
    //     for rolling forward. An unresolved account still rolls manual rows.
    //   - `rowCount`: the rows the balance adds on top of the snapshot, dated
    //     through today — one per row on the ledger, including a posted row that
    //     adds 0.00 because its pending half was already in the balance. Held,
    //     other-account and replaced pending rows are not counted.
    let sinceAnchor: { rowCount: number; net: string } | null = null;
    // ⭐ (Task 4, D) EVERY ROW BEHIND THAT FIGURE, WITH THE RULE'S OWN VERDICT.
    // The rows `classifyLedgerRowsThroughToday` read for the roll-forward
    // (anchor day − SUPERSEDE_MAX_DAYS through today: the rows dated later can
    // only pair, never count today), each with `classifyCashRows`' outcome as
    // it came back — `reason`, `counts`, `contribution`. Nothing is judged
    // here: Σ contribution of the `counted` rows is `sinceAnchor.net`, and their
    // number is `sinceAnchor.rowCount` (spineParity pins both).
    let explainRows: ExplainRow[] | null = null;
    if (anchorDay && settings?.bankSnapshotAt) {
      const cash = await classifyLedgerRowsThroughToday({
        householdId,
        anchor: { at: new Date(settings.bankSnapshotAt), day: anchorDay },
        accountExternalId: resolved.externalId,
        todayISO: todayDay,
      });
      sinceAnchor = {
        rowCount: cash.throughToday.rowCount,
        net: (Math.round(cash.throughToday.net * 100) / 100).toFixed(2),
      };
      explainRows = cash.rows.flatMap((o, i) => {
        if (o.occurredOn > todayDay) return [];
        const r = cash.read[i]!;
        return [
          {
            id: r.id,
            date: r.occurredOn,
            description: r.description,
            amount: r.amount.toFixed(2),
            pending: r.pending,
            accountExternalId: r.plaidAccountId,
            source: r.source,
            onAccount: isBankRow(r.source, r.plaidAccountId, resolved.externalId),
            counted: o.counts,
            contribution: (Math.round(o.contribution * 100) / 100).toFixed(2),
            reason: o.reason,
            replacedId: o.replacedId,
          },
        ];
      });
      // Newest first, the counted rows before the rest of a day: the list reads like a statement.
      explainRows.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.counted === b.counted ? 0 : a.counted ? -1 : 1));
    }

    // The most recent rows on the bank account, so a missing deposit is
    // visible instead of theoretical.
    const recentRows = resolved.externalId
      ? await db
          .select({
            occurredOn: transactionsTable.occurredOn,
            description: transactionsTable.description,
            amount: transactionsTable.amount,
            pending: transactionsTable.pending,
          })
          .from(transactionsTable)
          .where(
            and(
              eq(transactionsTable.householdId, householdId),
              eq(transactionsTable.plaidAccountId, resolved.externalId),
            ),
          )
          .orderBy(desc(transactionsTable.occurredOn))
          .limit(15)
      : [];

    const [signal, freshness] = await Promise.all([
      computeCashSignal(householdId, ownerUserId, { horizonDays: 90 }),
      computeBankFreshness(householdId, ownerUserId),
    ]);

    res.json({
      asOf: new Date().toISOString(),
      // (T1) The bank reading these figures roll forward from (the stored anchor's instant).
      dataAsOf: dataAsOfOf(settings?.bankSnapshotAt ?? null),
      // What every screen is showing right now.
      displayed: { bankToday: signal.bankToday },
      // Whether that balance can be trusted right now, and why not. The spine's
      // `bank` object carries the same fields from the same function.
      // (Q5 round 3) plus `fetchedAt`, the instant the confidence line's "Updated …" says.
      freshness: {
        ...freshness,
        fetchedAt: bankFetchedAt(
          freshness,
          settings?.bankSnapshotAt ? new Date(settings.bankSnapshotAt).toISOString() : null,
        ),
      },
      // The anchor it is built on.
      snapshot: {
        balance: settings?.bankSnapshotBalance ?? null,
        at: settings?.bankSnapshotAt
          ? new Date(settings.bankSnapshotAt).toISOString()
          : null,
        source: settings?.bankSnapshotSource ?? null,
        storedAccountId: settings?.bankSnapshotAccountId ?? null,
        name: settings?.bankSnapshotName ?? null,
        mask: settings?.bankSnapshotMask ?? null,
      },
      // Which account that anchor resolves to, and how we got there.
      account: {
        resolvedExternalId: resolved.externalId,
        resolvedRowId: resolved.rowId,
        via: resolved.via,
        name: owningAccount?.name ?? null,
        mask: owningAccount?.mask ?? null,
        belongsToItem: owningAccount?.itemId ?? null,
      },
      // Whether the next Sync will re-read the balance — and if not, why not.
      nextSync: { willRefreshBalance: willRefresh, whyNot },
      // Every linked institution and its last sync, so a stuck feed shows up.
      items: items.map((i) => ({
        ...i,
        lastSyncedAt: i.lastSyncedAt ? i.lastSyncedAt.toISOString() : null,
        ownsSnapshotAccount: owningAccount?.itemId === i.itemRowId,
      })),
      // Every checking-ish account on file — two rows for one real account is
      // the re-link twin that breaks the stored pointer.
      accounts: accounts.map((a) => ({
        externalId: a.externalId,
        name: a.name,
        mask: a.mask,
        type: a.type,
        subtype: a.subtype,
        isSnapshotAccount: a.rowId === resolved.rowId,
      })),
      ledger: {
        anchorDay,
        sinceAnchor,
        // (Task 4, D) Additive: null when there is no read time (no roll-forward).
        rows: explainRows,
        recentRows: recentRows.map((r) => ({
          date: r.occurredOn,
          description: r.description,
          amount: r.amount,
          pending: r.pending,
        })),
      },
    });
  },
);

export default router;
