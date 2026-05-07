ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "is_transfer_user_overridden" boolean DEFAULT false NOT NULL;
