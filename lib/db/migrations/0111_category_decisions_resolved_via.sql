-- 0111_category_decisions_resolved_via.sql — package V1 (categorization
-- automation: settings API + stable eligibility).
--
-- How an open decision was settled: 'user' (a person accepted, corrected or
-- skipped it — through the queue, a hand filing or a split) or 'silent' (a
-- provisional model suggestion that stood unchanged for 14 days; see
-- settleSilentAcceptances in artifacts/api-server/src/lib/categorizer/review.ts).
-- NULL = unresolved, or superseded by a newer engine decision.
--
-- `resolved_by` already holds WHO resolved it (a user id, or 'system' for an
-- engine supersede), so the new column is `resolved_via`, not `resolved_by`.
--
-- Idempotent and additive: the column is nullable; the CHECK is added only when
-- missing; the backfill only fills NULLs, so a second run changes nothing.
-- Must agree with `categoryDecisionsTable.resolvedVia` in
-- lib/db/src/schema/categorization.ts.

ALTER TABLE category_decisions
  ADD COLUMN IF NOT EXISTS resolved_via text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'category_decisions_resolved_via_ck'
  ) THEN
    ALTER TABLE category_decisions
      ADD CONSTRAINT category_decisions_resolved_via_ck
      CHECK (resolved_via IS NULL OR resolved_via IN ('user', 'silent'));
  END IF;
END
$$;

-- Every decision resolved before this file was resolved by a person, except the
-- engine's own supersedes (resolved_by = 'system'), which stay NULL.
UPDATE category_decisions
   SET resolved_via = 'user'
 WHERE resolved_at IS NOT NULL
   AND resolved_via IS NULL
   AND resolved_by IS DISTINCT FROM 'system';
