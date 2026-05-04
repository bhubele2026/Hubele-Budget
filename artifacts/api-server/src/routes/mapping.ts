import { Router, type IRouter } from "express";
import { and, eq, desc } from "drizzle-orm";
import { db, mappingRulesTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import {
  CreateMappingRuleBody,
  UpdateMappingRuleBody,
  UpdateMappingRuleParams,
  DeleteMappingRuleParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/mapping-rules", requireAuth, async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(mappingRulesTable)
    .where(eq(mappingRulesTable.userId, req.userId!))
    .orderBy(desc(mappingRulesTable.priority));
  res.json(rows);
});

router.post("/mapping-rules", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateMappingRuleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(mappingRulesTable)
    .values({ ...parsed.data, userId: req.userId! })
    .returning();
  res.status(201).json(row);
});

router.patch(
  "/mapping-rules/:id",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = UpdateMappingRuleParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = UpdateMappingRuleBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const [row] = await db
      .update(mappingRulesTable)
      .set(parsed.data)
      .where(
        and(
          eq(mappingRulesTable.id, params.data.id),
          eq(mappingRulesTable.userId, req.userId!),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(row);
  },
);

router.delete(
  "/mapping-rules/:id",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = DeleteMappingRuleParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    await db
      .delete(mappingRulesTable)
      .where(
        and(
          eq(mappingRulesTable.id, params.data.id),
          eq(mappingRulesTable.userId, req.userId!),
        ),
      );
    res.sendStatus(204);
  },
);

export default router;
