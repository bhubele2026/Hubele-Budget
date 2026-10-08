-- 0116_category_decisions_unreviewed.sql — package V7 (verified is not the same
-- as left unchanged).
--
-- A provisional model suggestion that nobody touched for 14 days used to be
-- settled as resolution 'accepted' (resolved_via 'silent') and counted toward
-- the model's record. Leaving a charge alone does not show its category is
-- right, so such a suggestion is now settled as 'unreviewed': it leaves the
-- review queue, stays provisional on its charge, and counts toward nothing
-- (not the record, not the model's priors). See settleSilentAcceptances in
-- artifacts/api-server/src/lib/categorizer/review.ts.
--
-- Idempotent:
--   * the CHECK is dropped and re-added only while it lacks 'unreviewed'
--     (looked up on the table the search_path resolves, so a replay into
--     another schema checks its own copy);
--   * the backfill only moves accepted + silent rows, so a second run finds
--     none.
-- Must agree with `category_decisions_resolution_ck` in
-- lib/db/src/schema/categorization.ts.

DO $$
DECLARE
  def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
    FROM pg_constraint c
   WHERE c.conrelid = 'category_decisions'::regclass
     AND c.conname = 'category_decisions_resolution_ck';
  IF def IS NULL OR position('unreviewed' IN def) = 0 THEN
    ALTER TABLE category_decisions DROP CONSTRAINT IF EXISTS category_decisions_resolution_ck;
    ALTER TABLE category_decisions
      ADD CONSTRAINT category_decisions_resolution_ck
      CHECK (resolution IS NULL OR resolution IN ('accepted', 'corrected', 'skipped', 'unreviewed'));
  END IF;
END
$$;

-- Every silent acceptance so far was a suggestion left unchanged, not one a
-- person verified.
UPDATE category_decisions
   SET resolution = 'unreviewed'
 WHERE resolution = 'accepted'
   AND resolved_via = 'silent';
