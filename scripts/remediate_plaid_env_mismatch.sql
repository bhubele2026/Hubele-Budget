-- Task #654 — One-shot remediation for Plaid items whose stored
-- access_token was minted in a different Plaid environment than the
-- server is currently configured for (e.g. an `access-sandbox-…`
-- token on a server with PLAID_ENV=production).
--
-- Background:
--   The user's two real Chase plaid_items rows (`5f231d46-…` and
--   `e93a1f81-…`) have sandbox-prefixed tokens that Plaid rejects with
--   INVALID_ACCESS_TOKEN ("provided access token is for the wrong
--   Plaid environment"). Until this script ran, both rows would only
--   re-stamp their reauth state on the next sync — but that sync also
--   failed, so the user could be stuck for a full poll cycle. This
--   stamps the reauth columns immediately so the Reconnect button
--   lights up on the next page load with no waiting.
--
-- Idempotent: only updates rows whose env-prefix doesn't match the
-- target env AND whose lastSyncErrorCode is currently null or already
-- INVALID_ACCESS_TOKEN. Re-running is a no-op once the user reconnects
-- (the new token's prefix matches and the WHERE clause excludes it).
--
-- :target_env defaults to 'production' below — match the live server's
-- PLAID_ENV. Override at runtime with:
--   psql -v target_env="'sandbox'" -f remediate_plaid_env_mismatch.sql

\set ON_ERROR_STOP on

DO $$
DECLARE
  target_env text := COALESCE(NULLIF(current_setting('plaid.target_env', true), ''), 'production');
  flagged_count integer;
BEGIN
  -- Drive the env from a SET so the same script can be invoked for
  -- non-production environments (test repls, staging) without editing.
  WITH updated AS (
    UPDATE plaid_items
    SET
      last_sync_error_code = 'INVALID_ACCESS_TOKEN',
      last_sync_error =
        'This bank was linked from a different Plaid environment. Please reconnect to refresh.'
    WHERE
      access_token IS NOT NULL
      AND access_token !~ ('^access-' || target_env || '-')
      AND access_token ~ '^access-(sandbox|development|production)-'
      AND (
        last_sync_error_code IS NULL
        OR last_sync_error_code = 'INVALID_ACCESS_TOKEN'
      )
    RETURNING id, institution_name
  )
  SELECT COUNT(*) INTO flagged_count FROM updated;

  RAISE NOTICE
    '[#654] flagged % env-mismatched plaid_items rows for reconnect (target_env=%)',
    flagged_count, target_env;
END $$;
