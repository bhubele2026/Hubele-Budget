/**
 * One-shot grandfather backfill for `transactions.sent_to_review_at`.
 *
 * Background (task #763 — follow-up to Phase B #762):
 *
 * Phase B shipped the `sent_to_review_at` column, the
 * /transactions/send-to-review + unsend-from-review endpoints, and the
 * Chase-page Send-to-Review UI. It deliberately left the column NULL
 * for every historical row so we could exercise the new gate in
 * production against newly-synced transactions only.
 *
 * Once the gate is verified, we still need to keep the Review inbox on
 * /forecast finite — without a backfill it would slowly fill up with
 * years of legacy rows that nobody actually intends to triage. This
 * script applies the two grandfather rules from the task spec:
 *
 *   Rule 1 (already-processed): any transaction that already has at
 *     least one `forecast_resolutions` row pointing at it (status in
 *     matched / missed / dismissed / rescheduled) was processed under
 *     the old auto-match regime and is implicitly already reviewed.
 *     Set `sent_to_review_at = NOW()`.
 *
 *   Rule 2 (stale enough to drop): any *remaining* transaction (i.e.
 *     with no qualifying `forecast_resolutions` row from rule 1) whose
 *     `occurred_on` is more than 30 days before today. Rule 1 and rule
 *     2 are mutually exclusive — a row matched by rule 1 is never also
 *     counted under rule 2. The 30-day cutoff is the "bake window" —
 *     anything
 *     newer is recent enough to be worth triaging in the new flow and
 *     stays NULL. The cutoff is intentionally documented here because
 *     it is a one-way data migration: once a row is grandfathered, the
 *     only way to put it back in the Review inbox is the
 *     /transactions/unsend-from-review endpoint.
 *
 * The script is idempotent: every UPDATE is gated on
 * `sent_to_review_at IS NULL`, so re-running it on already-backfilled
 * rows is a no-op. The dry-run mode (default) runs SELECT-only and
 * prints per-rule + total counts so we can sanity-check before
 * applying. `--apply` runs the UPDATE in a single transaction so the
 * two rules either both land or neither does.
 *
 * Out of scope:
 *   - Schema changes (`sent_to_review_at` already exists from #762).
 *   - Any wiring into post-deploy automation. This is a one-off
 *     recovery script — future rows stay NULL by default and only
 *     flip via the explicit Send-to-Review user action.
 *
 * Usage:
 *   ./scripts/node_modules/.bin/tsx \
 *     artifacts/api-server/scripts/backfill-sent-to-review-grandfather.ts
 *   ./scripts/node_modules/.bin/tsx \
 *     artifacts/api-server/scripts/backfill-sent-to-review-grandfather.ts --apply
 */

import { db } from "@workspace/db";
import {
  applyGrandfatherBackfill,
  countGrandfatherCandidates,
  GRANDFATHER_STALE_DAYS,
} from "../src/lib/sentToReviewGrandfatherBackfill";

const APPLY = process.argv.includes("--apply");

async function main(): Promise<void> {
  console.log(
    `[backfill-sent-to-review] mode=${APPLY ? "APPLY" : "DRY-RUN"} staleCutoffDays=${GRANDFATHER_STALE_DAYS}`,
  );

  const counts = await countGrandfatherCandidates();
  console.log(
    `[backfill-sent-to-review] candidates: rule1=${counts.rule1} rule2=${counts.rule2} total=${counts.total}`,
  );
  for (const h of counts.perHousehold) {
    console.log(
      `  household=${h.householdId ?? "<null>"} rule1=${h.rule1} rule2=${h.rule2}`,
    );
  }

  if (!APPLY) {
    console.log(
      "[backfill-sent-to-review] dry-run: nothing written. Re-run with --apply to backfill.",
    );
    await db.$client.end();
    return;
  }

  const result = await applyGrandfatherBackfill();
  console.log(
    `[backfill-sent-to-review] applied: rule1=${result.rule1Updated} rule2=${result.rule2Updated} total=${result.total}`,
  );
  await db.$client.end();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await db.$client.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
