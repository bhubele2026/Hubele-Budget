import { and, eq, getTableColumns, isNull, isNotNull, sql } from "drizzle-orm";
import {
  db,
  debtsTable,
  plaidAccountsTable,
  plaidItemsTable,
} from "@workspace/db";
import { logger } from "./logger";

/**
 * Minimum carried balance (USD) for a revolving Amex card to auto-move into
 * Avalanche. Keeps a pay-in-full card (Blue Cash ~$198) and charge cards
 * (Platinum, which report no APR) out of the sweep; a revolving card carrying
 * real debt (the Sky Card ~$10.5k) qualifies. Tunable.
 */
const AUTO_LINK_MIN_BALANCE = 1000;

/**
 * Auto-link revolving Amex credit cards to Avalanche debts — no clicks, no
 * typed numbers. A card qualifies when Plaid reports BOTH an APR and a minimum
 * payment (the revolving-debt signal — charge cards like Platinum report
 * neither) AND a materially carried balance (>= AUTO_LINK_MIN_BALANCE, so a
 * paid-off card isn't grabbed). Every figure — balance, APR, minimum — comes
 * straight from the cached Plaid `/liabilities/get` fields on
 * `plaid_accounts`; nothing is invented (CLAUDE.md §1).
 *
 * Once a card is linked, `amexAnchor` drops debt-linked cards from the Amex
 * band (`bandCards = cards.filter(c => c.debtId == null)`), so the card leaves
 * the Amex page and shows in Avalanche automatically. Reversible: deleting the
 * debt returns the card to the band.
 *
 * Runs as a one-shot startup sweep (all households) AND on link/Sync scoped to
 * one household. Idempotent — already-linked cards are filtered out, and a race
 * that beats us to the link is caught as PlaidAccountAlreadyLinkedError.
 * Best-effort: errors are logged, never thrown, never block boot or a sync.
 */
export async function runStartupLinkRevolvingAmexDebts(opts?: {
  householdId?: string;
}): Promise<{ scanned: number; linked: number; skipped: number }> {
  const summary = { scanned: 0, linked: 0, skipped: 0 };
  try {
    const conds = [
      // American Express items only (matches amexAnchor's discovery filter).
      sql`${plaidItemsTable.institutionSlug} ~* '(amex|american[-_\\s]*express)'`,
      eq(plaidAccountsTable.type, "credit"),
      sql`(${plaidAccountsTable.liabilityKind} is null or ${plaidAccountsTable.liabilityKind} = 'credit')`,
      // Revolving-debt signal from Plaid: an APR AND a minimum payment. Charge
      // cards (Platinum) carry neither, so they never qualify.
      isNotNull(plaidAccountsTable.liabilityApr),
      isNotNull(plaidAccountsTable.liabilityMinPayment),
      // Materially carried balance so a pay-in-full card isn't grabbed.
      sql`${plaidAccountsTable.liabilityBalance} is not null and ${plaidAccountsTable.liabilityBalance}::numeric >= ${AUTO_LINK_MIN_BALANCE}`,
      // Not already linked to a debt (left-join yields null).
      isNull(debtsTable.id),
    ];
    if (opts?.householdId) {
      conds.push(eq(plaidAccountsTable.householdId, opts.householdId));
    }

    const rows = await db
      .select({
        account: getTableColumns(plaidAccountsTable),
        institutionName: plaidItemsTable.institutionName,
      })
      .from(plaidAccountsTable)
      .innerJoin(
        plaidItemsTable,
        eq(plaidAccountsTable.itemId, plaidItemsTable.id),
      )
      .leftJoin(debtsTable, eq(debtsTable.plaidAccountId, plaidAccountsTable.id))
      .where(and(...conds));

    summary.scanned = rows.length;
    if (rows.length === 0) return summary;

    // Lazy import breaks the module cycle: routes/plaid already imports
    // lib/plaidLiabilities (which calls this sweep on Sync). Resolving
    // createOrLinkDebtFromPlaidAccount at call time keeps the static graph
    // acyclic.
    const { createOrLinkDebtFromPlaidAccount, PlaidAccountAlreadyLinkedError } =
      await import("../routes/plaid");

    for (const r of rows) {
      if (!r.account.householdId) {
        summary.skipped += 1;
        continue;
      }
      try {
        const { action } = await createOrLinkDebtFromPlaidAccount({
          userId: r.account.userId,
          householdId: r.account.householdId,
          account: r.account,
          institutionName: r.institutionName,
        });
        summary.linked += 1;
        logger.info(
          { plaidAccountId: r.account.id, action },
          "Auto-linked revolving Amex card to Avalanche",
        );
      } catch (err) {
        summary.skipped += 1;
        // A concurrent linker beat us to it — expected, not an error.
        if (err instanceof PlaidAccountAlreadyLinkedError) continue;
        logger.error(
          { err, plaidAccountId: r.account.id },
          "Auto-link revolving Amex card failed",
        );
      }
    }
    logger.info(summary, "Revolving-Amex auto-link sweep complete");
  } catch (err) {
    logger.error({ err }, "Revolving-Amex auto-link sweep failed");
  }
  return summary;
}
