import { Router, type IRouter } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { db, importBatchesTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { importWorkbook } from "../lib/workbookImporter";

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
      const counts = await importWorkbook(req.userId!, wb, batch!.id);
      res.json({ batchId: batch!.id, counts });
    } catch (e) {
      req.log.error({ err: e }, "Workbook import failed");
      const msg = e instanceof Error ? e.message : "Import failed";
      res.status(400).json({ error: msg });
    }
  },
);

export default router;
