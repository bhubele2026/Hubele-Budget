-- 0100_recap_sms.sql — recap settings, phone verification, SMS delivery ledger
-- and inbound-text audit (package AI-4b).
--
-- Idempotent and additive: every statement is IF NOT EXISTS, so running it
-- twice (or after `drizzle-kit push` already made the tables) changes
-- nothing. Must agree column for column with lib/db/src/schema/recap.ts;
-- recapSmsSchemaParity.integration.test.ts checks that.

CREATE TABLE IF NOT EXISTS recap_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  user_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  send_time_local text NOT NULL DEFAULT '07:00',
  timezone text NOT NULL DEFAULT 'America/Chicago',
  phone_e164 text,
  verified_at timestamptz,
  paused_until timestamptz,
  skip_weekends boolean NOT NULL DEFAULT false,
  extra_alerts boolean NOT NULL DEFAULT false,
  consent_text_version text,
  consented_at timestamptz,
  opted_out_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recap_settings_household_id_households_id_fk
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS recap_settings_household_user_uq
  ON recap_settings (household_id, user_id);
CREATE INDEX IF NOT EXISTS recap_settings_phone_idx
  ON recap_settings (phone_e164);

CREATE TABLE IF NOT EXISTS recap_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  user_id text NOT NULL,
  phone_e164 text NOT NULL,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recap_verifications_household_id_households_id_fk
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS recap_verifications_user_created_idx
  ON recap_verifications (user_id, created_at);

CREATE TABLE IF NOT EXISTS recap_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  user_id text NOT NULL,
  recap_id uuid,
  for_date date,
  kind text NOT NULL,
  to_e164 text NOT NULL,
  provider text NOT NULL,
  provider_message_id text,
  status text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recap_deliveries_household_id_households_id_fk
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  CONSTRAINT recap_deliveries_kind_check
    CHECK (kind in ('scheduled', 'test', 'verification', 'alert', 'reply')),
  CONSTRAINT recap_deliveries_status_check
    CHECK (status in ('queued', 'sent', 'delivered', 'undelivered', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS recap_deliveries_idempotency_uq
  ON recap_deliveries (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS recap_deliveries_user_date_scheduled_uq
  ON recap_deliveries (user_id, for_date) WHERE kind = 'scheduled';
CREATE INDEX IF NOT EXISTS recap_deliveries_provider_message_idx
  ON recap_deliveries (provider_message_id);
CREATE INDEX IF NOT EXISTS recap_deliveries_user_created_idx
  ON recap_deliveries (user_id, created_at);

CREATE TABLE IF NOT EXISTS sms_inbound (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_message_id text NOT NULL,
  from_e164 text NOT NULL,
  body_hash text NOT NULL,
  body_preview text,
  matched_user_id text,
  action text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sms_inbound_provider_message_id_unique UNIQUE (provider_message_id)
);
