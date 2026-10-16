import { Router, type IRouter } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { requireAuth } from "../middlewares/requireAuth";
import { importWorkbook, WorkbookImportError } from "../lib/workbookImporter";
import { restoreImportSnapshot } from "../lib/importSnapshot";

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
    let wb: XLSX.WorkBook;
    try {
      wb = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
    } catch (e) {
      req.log.warn({ err: e }, "Workbook import: the file did not parse");
      res.status(400).json({ error: "This file is not a workbook H2 can read." });
      return;
    }
    try {
      // (Task 7, V) The batch row is written inside the import's own
      // transaction (batch id null), so a refused or failed import writes
      // nothing at all — not even the batch.
      const result = await importWorkbook(req.userId!, req.householdId!, wb, null, {
        filename: req.file.originalname ?? null,
      });
      res.json({
        batchId: result.batchId,
        counts: result.counts,
        ruleAttributions: result.ruleAttributions,
        // Pre-import safety snapshot id — POST this to
        // /api/import/snapshots/:id/restore to undo the entire import.
        snapshotId: result.snapshotId,
      });
    } catch (e) {
      // A problem with the file is the person's to fix: say what it is. Any
      // other failure (a row the database refused, a lost connection) rolled
      // the whole import back; say that, never the database's own message
      // (it carries the SQL and the rows).
      if (e instanceof WorkbookImportError) {
        req.log.warn({ err: e }, "Workbook import refused");
        res.status(400).json({ error: e.message });
        return;
      }
      req.log.error({ err: e }, "Workbook import failed");
      res.status(500).json({ error: "The import could not be saved, so nothing was changed." });
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

export default router;
