import { Router, type IRouter } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { db, importBatchesTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { importWorkbook } from "../lib/workbookImporter";
import { restoreImportSnapshot } from "../lib/importSnapshot";
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
          householdId: req.householdId!,
          filename: req.file.originalname ?? null,
        })
        .returning();
      const result = await importWorkbook(req.userId!, req.householdId!, wb, batch!.id, {
        filename: req.file.originalname ?? null,
      });
      res.json({
        batchId: batch!.id,
        counts: result.counts,
        ruleAttributions: result.ruleAttributions,
        // Pre-import safety snapshot id — POST this to
        // /api/import/snapshots/:id/restore to undo the entire import.
        snapshotId: result.snapshotId,
      });
    } catch (e) {
      req.log.error({ err: e }, "Workbook import failed");
      const msg = e instanceof Error ? e.message : "Import failed";
      res.status(400).json({ error: msg });
    }
  },
);

// One-click restore of a pre-import snapshot. Recovers from an accidental
// workbook import by wiping the just-imported data and replaying the rows that
// existed before the import. Scoped to the calling user (the importer wipes by
// user_id, so the snapshot/restore use the same key). Idempotent: a snapshot
// can only be restored once (status flips to 'restored').
router.post(
  "/import/snapshots/:snapshotId/restore",
  requireAuth,
  async (req, res): Promise<void> => {
    const { snapshotId } = req.params;
    if (typeof snapshotId !== "string" || !snapshotId) {
      res.status(400).json({ error: "snapshotId required" });
      return;
    }
    try {
      const result = await restoreImportSnapshot(snapshotId, req.userId!);
      if (!result.ok) {
        res.status(result.status ?? 400).json({ error: result.error });
        return;
      }
      res.json({ ok: true, snapshotId: result.snapshotId, counts: result.counts });
    } catch (e) {
      req.log.error({ err: e }, "Import snapshot restore failed");
      const msg = e instanceof Error ? e.message : "Restore failed";
      res.status(500).json({ error: msg });
    }
  },
);

router.post(
  "/seed/april-chase",
  requireAuth,
  async (req, res): Promise<void> => {
    try {
      const result = await seedAprilChase(req.householdOwnerId!, req.householdId!);
      res.json(result);
    } catch (e) {
      req.log.error({ err: e }, "April Chase seed failed");
      const msg = e instanceof Error ? e.message : "Seed failed";
      res.status(500).json({ error: msg });
    }
  },
);

export default router;
