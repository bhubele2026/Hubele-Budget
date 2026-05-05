-- Per-account checking-balance snapshots for the Chase page multi-account
-- picker (#296). The legacy bank_snapshot_* columns continue to anchor the
-- Forecast page; this map adds anchors for any other linked checking
-- account so Starting/Ending balance render real values, not "unavailable".
ALTER TABLE "forecast_settings"
  ADD COLUMN IF NOT EXISTS "account_snapshots" jsonb;
