import { eq } from "drizzle-orm";
import { db, settingsTable, wishlistItemsTable, type WishlistItem } from "@workspace/db";
import { addDaysISO } from "@workspace/avalanche-core";
import { householdTodayISO } from "./householdClock";

// (AI-2) The wish list: an item waits (settings.preferences.wishlistWaitDays,
// default 7 days) before it can be decided yes. A "no" is always allowed.

export const DEFAULT_WISHLIST_WAIT_DAYS = 7;

export async function wishlistWaitDays(ownerUserId: string): Promise<number> {
  const [s] = await db.select({ preferences: settingsTable.preferences }).from(settingsTable).where(eq(settingsTable.userId, ownerUserId));
  const v = (s?.preferences as { wishlistWaitDays?: unknown } | null)?.wishlistWaitDays;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 90 ? v : DEFAULT_WISHLIST_WAIT_DAYS;
}

export async function addWishlistItem(
  householdId: string,
  ownerUserId: string,
  actorUserId: string,
  input: { title: string; amount?: number; url?: string | null; categoryId?: string | null; targetDate?: string | null },
): Promise<WishlistItem> {
  const waitDays = await wishlistWaitDays(ownerUserId);
  const [row] = await db
    .insert(wishlistItemsTable)
    .values({
      householdId,
      title: input.title,
      amount: input.amount === undefined ? null : input.amount.toFixed(2),
      url: input.url ?? null,
      categoryId: input.categoryId ?? null,
      targetDate: input.targetDate ?? null,
      requestedBy: actorUserId,
      waitingUntil: addDaysISO(householdTodayISO(), waitDays),
    })
    .returning();
  return row!;
}

export function daysBetween(fromISO: string, toISO: string): number {
  return Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86_400_000);
}

export function wishlistView(w: WishlistItem, todayISO: string = householdTodayISO()) {
  return {
    id: w.id,
    title: w.title,
    amount: w.amount === null ? null : Number(w.amount),
    url: w.url,
    categoryId: w.categoryId,
    targetDate: w.targetDate,
    requestedBy: w.requestedBy,
    requestedAt: w.requestedAt.toISOString(),
    waitingUntil: w.waitingUntil,
    waitingDaysLeft: Math.max(0, daysBetween(todayISO, w.waitingUntil)),
    decision: w.decision,
    decidedAt: w.decidedAt ? w.decidedAt.toISOString() : null,
  };
}
