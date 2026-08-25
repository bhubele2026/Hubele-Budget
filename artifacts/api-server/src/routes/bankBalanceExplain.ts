import { Router, type IRouter } from "express";
import { and, desc, eq, gt, lte } from "drizzle-orm";
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

const router: IRouter = Router();

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

    const anchorDay = settings?.bankSnapshotAt
      ? new Date(settings.bankSnapshotAt).toISOString().slice(0, 10)
      : null;
    const todayDay = new Date().toISOString().slice(0, 10);

    // What the roll-forward is adding on top of the anchor — the other half of
    // every figure on screen.
    let sinceAnchor: { rowCount: number; net: string } | null = null;
    if (anchorDay && resolved.externalId) {
      const rows = await db
        .select({ amount: transactionsTable.amount })
        .from(transactionsTable)
        .where(
          and(
            eq(transactionsTable.householdId, householdId),
            eq(transactionsTable.plaidAccountId, resolved.externalId),
            gt(transactionsTable.occurredOn, anchorDay),
            lte(transactionsTable.occurredOn, todayDay),
          ),
        );
      const net = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
      sinceAnchor = {
        rowCount: rows.length,
        net: (Math.round(net * 100) / 100).toFixed(2),
      };
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

    const signal = await computeCashSignal(householdId, ownerUserId, {
      horizonDays: 90,
    });

    res.json({
      asOf: new Date().toISOString(),
      // What every screen is showing right now.
      displayed: { bankToday: signal.bankToday },
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
