import { Router, type IRouter } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { db, importBatchesTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { importWorkbook } from "../lib/workbookImporter";
import { seedAprilChase } from "../lib/aprilChaseSeed";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const router: IRouter = Router();

router.post(
  "/import/workbook",
  requireAuth,
  upload.single("file"),
  async (req, res): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: "Missing 'file' field" });
      return;
    }
    try {
      const wb = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
      const [batch] = await db
        .insert(importBatchesTable)
        .values({
          userId: req.userId!,
          filename: req.file.originalname ?? null,
        })
        .returning();
      const result = await importWorkbook(req.userId!, wb, batch!.id);
      res.json({
        batchId: batch!.id,
        counts: result.counts,
        ruleAttributions: result.ruleAttributions,
      });
    } catch (e) {
      req.log.error({ err: e }, "Workbook import failed");
      const msg = e instanceof Error ? e.message : "Import failed";
      res.status(400).json({ error: msg });
    }
  },
);

router.post(
  "/seed/april-chase",
  requireAuth,
  async (req, res): Promise<void> => {
    try {
      const result = await seedAprilChase(req.userId!);
      res.json(result);
    } catch (e) {
      req.log.error({ err: e }, "April Chase seed failed");
      const msg = e instanceof Error ? e.message : "Seed failed";
      res.status(500).json({ error: msg });
    }
  },
);

export default router;
