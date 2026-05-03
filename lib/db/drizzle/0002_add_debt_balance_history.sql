CREATE TABLE IF NOT EXISTS "debt_balance_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "debt_id" uuid NOT NULL,
  "recorded_on" date NOT NULL,
  "balance" numeric(12, 2) DEFAULT '0' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "debt_balance_history" ADD CONSTRAINT "debt_balance_history_debt_id_debts_id_fk" FOREIGN KEY ("debt_id") REFERENCES "public"."debts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "debt_balance_history_user_debt_day_uq" ON "debt_balance_history" USING btree ("user_id","debt_id","recorded_on");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "debt_balance_history_user_debt_idx" ON "debt_balance_history" USING btree ("user_id","debt_id");
