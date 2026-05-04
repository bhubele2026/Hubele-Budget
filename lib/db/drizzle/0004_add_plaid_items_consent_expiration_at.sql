-- (#238) Persist Plaid's `consent_expiration_time` so the
-- PENDING_EXPIRATION / PENDING_DISCONNECT reconnect banners can show the
-- actual cutoff date ("Chase will disconnect on May 21") instead of the
-- date-less fallback copy. Captured at exchange time and refreshed on
-- every successful sync so the value tracks the user re-consenting.
--
-- Idempotent: safe to run on databases that already have the column.

ALTER TABLE "plaid_items"
  ADD COLUMN IF NOT EXISTS "consent_expiration_at" timestamp with time zone;
