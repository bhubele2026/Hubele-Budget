ALTER TABLE "debts" ADD COLUMN IF NOT EXISTS "plaid_account_id" uuid;--> statement-breakpoint
ALTER TABLE "debts" ADD COLUMN IF NOT EXISTS "plaid_last_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "debts" ADD COLUMN IF NOT EXISTS "balance_source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "debts" ADD COLUMN IF NOT EXISTS "apr_source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "debts" ADD COLUMN IF NOT EXISTS "min_payment_source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "plaid_accounts" ADD COLUMN IF NOT EXISTS "liability_kind" text;--> statement-breakpoint
ALTER TABLE "plaid_accounts" ADD COLUMN IF NOT EXISTS "liability_balance" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "plaid_accounts" ADD COLUMN IF NOT EXISTS "liability_apr" numeric(6, 4);--> statement-breakpoint
ALTER TABLE "plaid_accounts" ADD COLUMN IF NOT EXISTS "liability_min_payment" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "plaid_accounts" ADD COLUMN IF NOT EXISTS "liability_last_fetched_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "debts" ADD CONSTRAINT "debts_plaid_account_id_plaid_accounts_id_fk" FOREIGN KEY ("plaid_account_id") REFERENCES "public"."plaid_accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "debts_plaid_account_idx" ON "debts" USING btree ("plaid_account_id");
