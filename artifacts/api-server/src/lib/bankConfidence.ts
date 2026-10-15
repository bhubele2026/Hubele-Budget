// ⭐ (Q1) CAN THE BANK BALANCE BE TRUSTED? — the spine's `bankConfidence`.
//
// The owner saw the dashboard say "Up to date" (that was only "nothing to
// review") while Banking said "Balance check: Not checked yet". The only real
// evidence is the bank's own balance checked against H2's. This reads, for the
// forecast's account, everything a tile needs to say it — and nothing is
// computed here that another function already computes:
//
//   fetchedAt    when the bank last told us anything (`lastHeardAt`, the
//                freshness rule's own instant: a Plaid balance re-read or a
//                successful sync; a typed balance's own time). Null with no
//                snapshot.
//   bankBalance  the bank's own figure as read (`bankBalanceParts(ledger)
//   bankAsOf     .snapshot`, = spine.bank.snapshot) and when.
//   h2Balance    H2's balance today: that snapshot rolled forward through the
//                ledger (`signal.bankToday`, = spine.bank.balance).
//   check        the last manual Sync's check of the two (F3,
//                `readBankBalanceCheck`: status / reason / stale / difference /
//                direction / when) — one query at most, no Plaid call; the very
//                read GET /banking/review's `balanceCheck` makes for the
//                forecast account.
//   pendingCount the pending rows H2's balance counts on that account, dated
//                through today (`readLedgerTotals(...).pendingCount`, the SQL
//                GET /banking/review's `cashFlow.pendingCount` runs).
//
// ⚠️ READ-ONLY. No write, no Plaid call: it sits on the spine's path. The
// household's own cash only — never a debt, a limit or credit.

import { eq } from "drizzle-orm";
import { db, forecastSettingsTable } from "@workspace/db";
import { bankBalanceParts, type DetailedCashSignal } from "./cashSignal";
import { bankFetchedAt, type BankFreshness } from "./bankFreshness";
import { loadRegister, money, readLedgerTotals, resolveLedgerScope } from "./bankLedger";
import { readBankBalanceCheck } from "./bankBalanceCheck";

export interface BankConfidence {
  fetchedAt: string | null;
  bankBalance: string | null;
  bankAsOf: string | null;
  h2Balance: string | null;
  check: {
    status: "matches" | "off_by" | "resolved_since" | "not_checked";
    reason: string | null;
    stale: boolean;
    staleReason: string | null;
    checkedAt: string | null;
    /** |bank − H2| at the check ("0.00" when it matched); null when not compared. */
    difference: string | null;
    direction: "bank_higher" | "bank_lower" | null;
  };
  pendingCount: number;
}

export async function readBankConfidence(
  householdId: string,
  ownerUserId: string,
  opts: {
    cash: Promise<DetailedCashSignal> | DetailedCashSignal;
    freshness: Promise<BankFreshness> | BankFreshness;
  },
): Promise<BankConfidence> {
  const cashRead = Promise.resolve(opts.cash);
  const signalRead = cashRead.then((c) => c.signal);
  // The forecast's account (and its twins), anchored on THIS request's signal —
  // the scope GET /banking/review resolves when no account is named.
  const [scope, settingsRows] = await Promise.all([
    resolveLedgerScope(householdId, ownerUserId, undefined, { signal: signalRead }),
    db
      .select({ tie: forecastSettingsTable.lastBankReconciliation, anchorAt: forecastSettingsTable.bankSnapshotAt })
      .from(forecastSettingsTable)
      .where(eq(forecastSettingsTable.userId, ownerUserId)),
  ]);
  const register = await loadRegister(scope);
  const settings = settingsRows[0];
  const [totals, check, cash, freshness] = await Promise.all([
    readLedgerTotals(scope, { to: scope.anchor.today }, register),
    readBankBalanceCheck({
      householdId,
      record: settings?.tie ?? null,
      isForecastAccount: scope.snapshotAccount,
      accountIds: scope.plaidAccountIds,
      currentAnchorAt: settings?.anchorAt ?? null,
    }),
    cashRead,
    Promise.resolve(opts.freshness),
  ]);
  const snapshot = bankBalanceParts(cash.ledger).snapshot;
  return {
    fetchedAt: bankFetchedAt(freshness, snapshot?.at ?? null),
    bankBalance: snapshot?.balance ?? null,
    bankAsOf: snapshot?.at ?? null,
    h2Balance: cash.signal.bankToday,
    check: {
      status: check.status,
      reason: check.reason,
      stale: check.stale,
      staleReason: check.staleReason,
      checkedAt: check.checkedAt,
      difference: check.differenceCents == null ? null : money(check.differenceCents),
      direction: check.direction,
    },
    pendingCount: totals.pendingCount,
  };
}
