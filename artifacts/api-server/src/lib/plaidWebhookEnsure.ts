import { eq } from "drizzle-orm";
import { db, plaidItemsTable } from "@workspace/db";
import { isSyntheticPlaidItem, plaid } from "./plaid";
import { logger } from "./logger";

// (V3) Automatic bank updates for banks that are already linked.
//
// `POST /plaid/webhook` only hears from a bank if Plaid was told the address.
// The link flow passes it for NEW links, so a bank linked before
// PLAID_WEBHOOK_URL was set stayed silent. This registers the address on
// existing items with `/item/webhook/update`.
//
// ⚠️ PLAID COST LAW. `/item/webhook/update` is free and is the ONLY Plaid call
// in this file. Nothing here may call `transactionsRefresh` (billable; the
// household was once billed ~$500 for background pulls).
//
// ⚠️ NEVER THROWS. A bank that refuses the address must not stop a sync, the
// categorize/monitor hand-off, or boot.

export const WEBHOOK_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

export type WebhookEnsureState = "no_url" | "ok" | "registered" | "error";

export interface EnsureItem {
  id: string;
  accessToken: string;
  webhookUrl?: string | null;
  webhookCheckedAt?: Date | null;
}

/** The address Plaid should call, or null when the server has none. */
export function desiredWebhookUrl(): string | null {
  const v = process.env.PLAID_WEBHOOK_URL?.trim();
  return v ? v : null;
}

export async function ensureItemWebhook(
  item: EnsureItem,
  opts: { now?: Date } = {},
): Promise<{ state: WebhookEnsureState }> {
  try {
    const desired = desiredWebhookUrl();
    if (!desired) return { state: "no_url" };
    const now = opts.now ?? new Date();
    if (
      item.webhookUrl === desired &&
      item.webhookCheckedAt &&
      now.getTime() - item.webhookCheckedAt.getTime() < WEBHOOK_RECHECK_MS
    ) {
      return { state: "ok" };
    }
    try {
      await plaid().itemWebhookUpdate({
        access_token: item.accessToken,
        webhook: desired,
      });
    } catch (err) {
      const raw =
        (err as { response?: { data?: { error_message?: string } } })?.response?.data
          ?.error_message ?? (err instanceof Error ? err.message : String(err));
      const message = String(raw).split(item.accessToken).join("[token]").slice(0, 300);
      await db
        .update(plaidItemsTable)
        .set({ webhookError: message, webhookCheckedAt: now })
        .where(eq(plaidItemsTable.id, item.id));
      logger.warn({ itemRowId: item.id, message }, "[plaid-webhook] address not registered");
      return { state: "error" };
    }
    await db
      .update(plaidItemsTable)
      .set({ webhookUrl: desired, webhookCheckedAt: now, webhookError: null })
      .where(eq(plaidItemsTable.id, item.id));
    return { state: "registered" };
  } catch (err) {
    logger.warn({ err, itemRowId: item.id }, "[plaid-webhook] ensure failed (non-fatal)");
    return { state: "error" };
  }
}

/** Once per boot: every real item gets at most one update call. */
export async function ensureAllItemWebhooks(
  opts: { now?: Date } = {},
): Promise<Record<WebhookEnsureState, number>> {
  const tally: Record<WebhookEnsureState, number> = { no_url: 0, ok: 0, registered: 0, error: 0 };
  try {
    if (!desiredWebhookUrl()) return tally;
    const items = await db.select().from(plaidItemsTable);
    for (const it of items) {
      if (isSyntheticPlaidItem(it)) continue;
      const r = await ensureItemWebhook(it, opts);
      tally[r.state]++;
    }
    logger.info({ tally }, "[plaid-webhook] boot sweep done");
  } catch (err) {
    logger.warn({ err }, "[plaid-webhook] boot sweep failed (non-fatal)");
  }
  return tally;
}
