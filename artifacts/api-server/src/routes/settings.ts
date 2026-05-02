import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, settingsTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { UpdateSettingsBody } from "@workspace/api-zod";

const router: IRouter = Router();

async function loadOrCreate(userId: string) {
  const [existing] = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.userId, userId));
  if (existing) return existing;
  const [created] = await db
    .insert(settingsTable)
    .values({ userId })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [row] = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.userId, userId));
  return row!;
}

router.get("/settings", requireAuth, async (req, res): Promise<void> => {
  const s = await loadOrCreate(req.userId!);
  res.json(s);
});

router.put("/settings", requireAuth, async (req, res): Promise<void> => {
  const parsed = UpdateSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await loadOrCreate(req.userId!);
  const [row] = await db
    .update(settingsTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(settingsTable.userId, req.userId!))
    .returning();
  res.json(row);
});

export default router;
