import { Router, type IRouter, type Request, type Response } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { requireAuth } from "../middlewares/requireAuth";
import {
  fileSha256,
  importWorkbook,
  ImportPreviewStaleError,
  planWorkbook,
  previewWorkbookImport,
  WorkbookImportError,
  type WorkbookPlan,
} from "../lib/workbookImporter";
import {
  listImportHistory,
  previewImportRestore,
  restoreImportSnapshot,
  RESTORE_WORDS,
} from "../lib/importSnapshot";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const router: IRouter = Router();

const NOT_A_WORKBOOK = "This file is not a workbook H2 can read.";
const CONFIRM_FIRST = "Preview the file first, then confirm the import.";
const IMPORT_FAILED = "The import could not be saved, so nothing was changed.";
const PREVIEW_FAILED = "The preview could not be made. Nothing was changed.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * (W) The uploaded file, read and checked (no database). Answers the 400 itself
 * and returns null when the file is missing, unreadable or wrong: the person
 * gets every problem found, in the file's own words (sheet, row, field).
 */
function readUpload(req: Request, res: Response): { wb: XLSX.WorkBook; plan: WorkbookPlan; sha: string } | null {
  if (!req.file) {
    res.status(400).json({ error: "Missing 'file' field" });
    return null;
  }
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
  } catch (e) {
    req.log.warn({ err: e }, "Workbook import: the file did not parse");
    res.status(400).json({ error: NOT_A_WORKBOOK, errors: [NOT_A_WORKBOOK] });
    return null;
  }
  try {
    return { wb, plan: planWorkbook(wb), sha: fileSha256(req.file.buffer) };
  } catch (e) {
    if (e instanceof WorkbookImportError) {
      req.log.warn({ err: e }, "Workbook import refused");
      res.status(400).json({ error: e.message, errors: e.problems });
      return null;
    }
    throw e;
  }
}

// (W) The dry run. The same reading and checks as the import, then what the
// import would add and replace (bank rows counted, with their first and last
// day). Writes nothing (a read-only transaction). The answer carries the
// confirmation the import requires.
router.post(
  "/import/workbook/preview",
  requireAuth,
  upload.single("file"),
  async (req, res): Promise<void> => {
    try {
      const file = readUpload(req, res);
      if (!file) return;
      const preview = await previewWorkbookImport(req.userId!, file.wb, {
        fileSha: file.sha,
        filename: req.file?.originalname ?? null,
        plan: file.plan,
      });
      res.json(preview);
    } catch (e) {
      req.log.error({ err: e }, "Workbook import preview failed");
      res.status(500).json({ error: PREVIEW_FAILED });
    }
  },
);

router.post(
  "/import/workbook",
  requireAuth,
  upload.single("file"),
  async (req, res): Promise<void> => {
    let file: ReturnType<typeof readUpload>;
    try {
      file = readUpload(req, res);
    } catch (e) {
      req.log.error({ err: e }, "Workbook import failed");
      res.status(500).json({ error: IMPORT_FAILED });
      return;
    }
    if (!file) return;
    // (W) An import replaces the person's data: it runs only with the
    // confirmation of a preview of this very file.
    const raw = (req.body as Record<string, unknown> | undefined)?.confirm ?? req.query.confirm;
    const confirm = typeof raw === "string" ? raw.trim() : "";
    if (!confirm) {
      res.status(428).json({ error: CONFIRM_FIRST, code: "confirm_required" });
      return;
    }
    try {
      // (Task 7, V) The batch row is written inside the import's own
      // transaction (batch id null), so a refused or failed import writes
      // nothing at all — not even the batch.
      const result = await importWorkbook(req.userId!, req.householdId!, file.wb, null, {
        filename: req.file?.originalname ?? null,
        plan: file.plan,
        confirm: { token: confirm, fileSha: file.sha },
      });
      res.json({
        batchId: result.batchId,
        counts: result.counts,
        ruleAttributions: result.ruleAttributions,
        // Pre-import safety snapshot id — Settings › Data › History restores it
        // (POST /api/import/snapshots/:id/restore).
        snapshotId: result.snapshotId,
        replaced: result.replaced,
      });
    } catch (e) {
      // A problem with the file is the person's to fix: say what it is. Any
      // other failure (a row the database refused, a lost connection) rolled
      // the whole import back; say that, never the database's own message
      // (it carries the SQL and the rows).
      if (e instanceof WorkbookImportError) {
        req.log.warn({ err: e }, "Workbook import refused");
        res.status(400).json({ error: e.message, errors: e.problems });
        return;
      }
      if (e instanceof ImportPreviewStaleError) {
        res.status(409).json({ error: e.message, code: "preview_stale" });
        return;
      }
      req.log.error({ err: e }, "Workbook import failed");
      res.status(500).json({ error: IMPORT_FAILED });
    }
  },
);

// (W) The person's imports, newest first, each with whether it can be restored.
router.get("/import/history", requireAuth, async (req, res): Promise<void> => {
  const n = Number(req.query.limit ?? 10);
  const limit = Number.isInteger(n) && n > 0 ? Math.min(n, 20) : 10;
  try {
    res.json({ items: await listImportHistory(req.userId!, limit) });
  } catch (e) {
    req.log.error({ err: e }, "Import history failed");
    res.status(500).json({ error: "Import history could not be read." });
  }
});

// (W) What restoring would do, or why it cannot (later changes it would lose,
// with the count). Reads only.
router.get(
  "/import/snapshots/:snapshotId/restore-preview",
  requireAuth,
  async (req, res): Promise<void> => {
    const { snapshotId } = req.params;
    if (typeof snapshotId !== "string" || !UUID.test(snapshotId)) {
      res.status(404).json({ error: RESTORE_WORDS.notFound });
      return;
    }
    try {
      const result = await previewImportRestore(snapshotId, req.userId!);
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json(result.preview);
    } catch (e) {
      req.log.error({ err: e }, "Import restore preview failed");
      res.status(500).json({ error: "The restore check could not be made. Nothing was changed." });
    }
  },
);

// Restore a pre-import snapshot: the import's data out, the rows from before it
// back. Scoped to the calling user (the importer wipes by user_id, so the
// snapshot/restore use the same key). (W) Refused, with nothing written, when
// it would lose anything: already restored, a later import still in place, an
// import too old to tell, or changes since the import (409 with the reason).
router.post(
  "/import/snapshots/:snapshotId/restore",
  requireAuth,
  async (req, res): Promise<void> => {
    const { snapshotId } = req.params;
    if (typeof snapshotId !== "string" || !UUID.test(snapshotId)) {
      res.status(404).json({ error: RESTORE_WORDS.notFound, code: "not_found" });
      return;
    }
    try {
      const result = await restoreImportSnapshot(snapshotId, req.userId!);
      if (!result.ok) {
        res.status(result.status).json({ error: result.error, code: result.code, changes: result.changes });
        return;
      }
      res.json({ ok: true, snapshotId: result.snapshotId, counts: result.counts });
    } catch (e) {
      // The restore is one transaction: a failure rolled all of it back. Never
      // the database's own words (they carry the SQL and the rows).
      req.log.error({ err: e }, "Import snapshot restore failed");
      res.status(500).json({ error: RESTORE_WORDS.failed });
    }
  },
);

export default router;
