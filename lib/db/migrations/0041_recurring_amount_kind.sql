-- PR-B1 · recurring_items.amount_kind
--
-- 'fixed' — the amount is what will post; 'estimate' — a figure the household
-- expects to vary (a utility, a variable paycheck). The money position reads it
-- to say its answer is estimated and which plans make it so. Every existing
-- plan reads 'fixed', exactly as it is treated today. Idempotent.
ALTER TABLE recurring_items
  ADD COLUMN IF NOT EXISTS amount_kind text NOT NULL DEFAULT 'fixed';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'recurring_items_amount_kind_check'
  ) THEN
    ALTER TABLE recurring_items
      ADD CONSTRAINT recurring_items_amount_kind_check CHECK (amount_kind in ('fixed', 'estimate'));
  END IF;
END
$$;
