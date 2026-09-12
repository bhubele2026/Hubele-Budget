import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, settingsTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { UpdateSettingsBody } from "@workspace/api-zod";
import {
  dedupeTransactionsAcrossAccountsForUser,
  dedupeTransactionsForUser,
} from "../lib/dedupeTransactions";

const router: IRouter = Router();

// (#623) settings is one-row-per-household. The legacy schema keys
// rows by userId (the owner's Clerk id, post-backfill); we look up
// and upsert by `req.householdOwnerId` so any member of the
// household reads/writes the same row.
async function loadOrCreate(ownerUserId: string, householdId: string) {
  const [existing] = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.userId, ownerUserId));
  if (existing) return existing;
  const [created] = await db
    .insert(settingsTable)
    .values({ userId: ownerUserId, householdId })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [row] = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.userId, ownerUserId));
  return row!;
}

router.get("/settings", requireAuth, async (req, res): Promise<void> => {
  const s = await loadOrCreate(req.householdOwnerId!, req.householdId!);
  res.json(s);
});

// (#800 — one-shot admin) Run the fuzzy-description-aware dedupe pass
// for the calling user's household owner. Exists to clean up the
// production residue identified by the May+ twin scan as the first
// real-world exercise of the new dedupe code. Auth-gated by the
// caller's session and additionally requires `{ confirm: "yes" }` in
// the body so a stray POST cannot delete data. Returns the per-user
// + cross-account dedupe reports. Delete this endpoint after the
// one-time prod cleanup is verified.
router.post(
  "/settings/admin/run-dedupe",
  requireAuth,
  async (req, res): Promise<void> => {
    const body = (req.body ?? {}) as { confirm?: unknown };
    if (body.confirm !== "yes") {
      res.status(400).json({
        error: "Missing { confirm: 'yes' } in body",
      });
      return;
    }
    const ownerUserId = req.householdOwnerId!;
    const perUser = await dedupeTransactionsForUser(ownerUserId);
    const crossAccount = await dedupeTransactionsAcrossAccountsForUser(
      ownerUserId,
    );
    res.json({ ownerUserId, perUser, crossAccount });
  },
);

/**
 * Preference keys the SERVER writes into `settings.preferences`, never the
 * settings UI. None is in the OpenAPI `SettingsPreferences` schema, so the
 * generated `UpdateSettingsBody` strips them from every PUT body; because PUT
 * replaces the whole `preferences` object, a web preferences save (which sends
 * `{...prev, ...patch}`) used to delete all of them.
 *
 * PUT /settings therefore always keeps the value the row already holds for each
 * key, and never takes one from the request: a browser's copy can be stale (a
 * Plaid sync may have moved the anchor since the page loaded).
 *
 * - `amexAnchor`: `lib/amexAnchor.ts` refreshAmexAnchor, and POST/DELETE
 *   /amex/anchor. Its `lastAutoBalance` is how the refresh tells a hand-edited
 *   Amex debt balance from its own last write.
 * - `amexCleanupDoneAt`: `routes/amex.ts`, the one-shot duplicate-account heal
 *   stamp.
 * - `budgetCategoriesV2`: `routes/budget.ts`, the one-time category
 *   consolidation gate.
 * - `budgetMay2026AmountsV1`: `routes/budget.ts`, the one-time May 2026
 *   planned-amount gate.
 * - `defaultsSeededAt`: `routes/budget.ts` seedDefaultsOnce, when the
 *   household's default categories, bills and rules were settled. Losing it
 *   would not re-seed a household with data, but it is the durable record.
 *
 * A new server-written preference key belongs in this list.
 */
export const SERVER_OWNED_PREFERENCE_KEYS = [
  "amexAnchor",
  "amexCleanupDoneAt",
  "budgetCategoriesV2",
  "budgetMay2026AmountsV1",
  "defaultsSeededAt",
] as const;

/**
 * The preferences to store for a PUT: the request's object as sent (nested maps
 * replaced, not merged, so removing a week from `weeklyAllowanceOverrides`
 * removes it), with each server-owned key taken from the stored row instead.
 * `null` still clears the user's keys; it stays `null` only when the row holds
 * no server-owned key.
 */
export function keepServerOwnedPreferences(
  stored: unknown,
  incoming: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const kept: Record<string, unknown> = {};
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    const storedObj = stored as Record<string, unknown>;
    for (const key of SERVER_OWNED_PREFERENCE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(storedObj, key)) {
        kept[key] = storedObj[key];
      }
    }
  }
  if (incoming === null && Object.keys(kept).length === 0) return null;
  const next: Record<string, unknown> = { ...(incoming ?? {}) };
  for (const key of SERVER_OWNED_PREFERENCE_KEYS) delete next[key];
  return { ...next, ...kept };
}

router.put("/settings", requireAuth, async (req, res): Promise<void> => {
  const parsed = UpdateSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const ownerUserId = req.householdOwnerId!;
  await loadOrCreate(ownerUserId, req.householdId!);
  const { preferences, ...rest } = parsed.data;
  const row = await db.transaction(async (tx) => {
    // A body without `preferences` leaves the column alone, as before.
    let preferencesSet: { preferences?: Record<string, unknown> | null } = {};
    if (preferences !== undefined) {
      // Lock the row so a server write that lands between this read and the
      // update below is not overwritten with the value read here.
      const [current] = await tx
        .select({ preferences: settingsTable.preferences })
        .from(settingsTable)
        .where(eq(settingsTable.userId, ownerUserId))
        .for("update");
      preferencesSet = {
        preferences: keepServerOwnedPreferences(current?.preferences, preferences),
      };
    }
    const [updated] = await tx
      .update(settingsTable)
      .set({ ...rest, ...preferencesSet, updatedAt: new Date() })
      .where(eq(settingsTable.userId, ownerUserId))
      .returning();
    return updated;
  });
  res.json(row);
});

export default router;
