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

router.put("/settings", requireAuth, async (req, res): Promise<void> => {
  const parsed = UpdateSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await loadOrCreate(req.householdOwnerId!, req.householdId!);
  const [row] = await db
    .update(settingsTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(settingsTable.userId, req.householdOwnerId!))
    .returning();
  res.json(row);
});

export default router;
