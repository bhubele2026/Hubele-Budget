-- (#274) Persist the user's dismissal of the dashboard
-- "bank consent expiring soon" alert across reloads.
--
-- We store the value of `consent_expiration_at` at the moment the
-- user clicked dismiss. The dashboard banner suppresses an item only
-- while its current cutoff equals this stored value. If Plaid's
-- cutoff later moves (a successful re-consent rolls it months out;
-- in practice that pushes the item out of the alert window anyway)
-- or a different item enters the window, the banner reappears
-- naturally without needing a separate "clear dismissal" call.
--
-- Idempotent: safe to run on databases that already have the column.

ALTER TABLE "plaid_items"
  ADD COLUMN IF NOT EXISTS "consent_warning_dismissed_for_cutoff"
    timestamp with time zone;
