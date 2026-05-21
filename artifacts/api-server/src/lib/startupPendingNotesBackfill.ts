import { sql } from "drizzle-orm";
import { db, transactionsTable } from "@workspace/db";
import { logger } from "./logger";

/**
 * (#738) One-shot startup pass: apply the legacy `notes='[pending]'`
 * marker cleanup to whatever database the API server is currently
 * pointed at. This is the production-side counterpart to the dev-side
 * `scripts/post-merge.sh` block (lines 57-61) which runs the same
 * `scripts/backfill_transactions_pending.sql` against `$DATABASE_URL`
 * on every task merge — but only in the dev environment. The Replit
 * autoscale deployment config (`.replit` → `[deployment.postBuild]`)
 * only runs `pnpm store prune`, so the production DB never sees the
 * cleanup unless we apply it on boot.
 *
 * Two passes, mirroring the SQL file exactly:
 *
 *   1. Stamp `pending = TRUE` on every row whose `notes` still carries
 *      the legacy `[pending]` marker but whose boolean was never
 *      flipped. Pre-#728 sync paths wrote the marker into `notes`
 *      instead of a first-class column; this pass migrates the signal
 *      onto the boolean so the vanished-pending sweep from #732 / #734
 *      can see those rows.
 *   2. Surgically strip the `[pending]` token out of `notes` (case-
 *      insensitive substring removal, then trim, then NULLIF '') so
 *      the Amex page (which renders `t.notes` directly under the
 *      merchant — see `artifacts/h2budget/src/pages/amex.tsx:2107`
 *      and `:2325`) stops showing literal `[pending]` text. User-typed
 *      content around the marker is preserved verbatim.
 *
 * Both passes are guarded by `notes ILIKE '%[pending]%'`, so once the
 * DB has converged this function matches zero rows and returns
 * `{ pendingFlagBackfilled: 0, notesMarkerStripped: 0 }`. That makes it
 * safe to re-run on every boot as a permanent self-heal — any future
 * row that somehow picks up the marker gets cleaned up on the next
 * restart without operator intervention.
 *
 * Best-effort: errors are caught at the call site in `index.ts` and
 * never block `app.listen()` — a transient DB hiccup on boot must not
 * keep the server from serving requests.
 */
export async function runStartupPendingNotesBackfill(): Promise<{
  pendingFlagBackfilled: number;
  notesMarkerStripped: number;
  durationMs: number;
}> {
  const startedAt = Date.now();
  // Pass 1 — mirror of step 1 in scripts/backfill_transactions_pending.sql.
  // ILIKE substring match (not equality) so a historical row like
  // "[pending] reimburse from work" still gets migrated.
  const flagResult = await db
    .update(transactionsTable)
    .set({ pending: true })
    .where(
      sql`${transactionsTable.notes} ilike '%[pending]%' and ${transactionsTable.pending} = false`,
    );
  const pendingFlagBackfilled = flagResult.rowCount ?? 0;

  // Pass 2 — mirror of step 2 in the SQL file. Surgically remove the
  // `[pending]` token (gi = global, case-insensitive), btrim the
  // remainder, and NULLIF empty strings back to NULL so a row whose
  // notes was exactly the marker returns to a clean NULL state. Any
  // user-typed prefix/suffix is preserved.
  const stripResult = await db
    .update(transactionsTable)
    .set({
      notes: sql`nullif(btrim(regexp_replace(${transactionsTable.notes}, '\\[pending\\]', '', 'gi')), '')`,
    })
    .where(sql`${transactionsTable.notes} ilike '%[pending]%'`);
  const notesMarkerStripped = stripResult.rowCount ?? 0;

  return {
    pendingFlagBackfilled,
    notesMarkerStripped,
    durationMs: Date.now() - startedAt,
  };
}

// Re-export the logger reference for symmetry with the other startup
// helpers, even though the actual logging happens at the call site.
export { logger };
