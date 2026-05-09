-- (#623) Shared household data model.
--
-- Adds a single nullable `household_owner_id` column to `profiles`.
-- For the owner this is NULL (they own themselves); for any invited
-- family member it holds the OWNER's Clerk userId, which the
-- `requireAuth` middleware uses to remap `req.userId` so every
-- existing route — keyed on `req.userId` — reads and writes the
-- shared household's rows. The signed-in user's real id is preserved
-- on `req.actualUserId` for owner-gating and self-removal checks.
--
-- The column is nullable on purpose: existing profile rows (the owner
-- and anyone who signed in before this migration) keep NULL, which
-- the middleware treats as "needs first-time resolution" and back-
-- fills correctly via the gated path (owner email match or accepted
-- Clerk invitation) on next sign-in.
--
-- Idempotent: safe to run on databases that already have the column.

ALTER TABLE "profiles"
  ADD COLUMN IF NOT EXISTS "household_owner_id" text;
