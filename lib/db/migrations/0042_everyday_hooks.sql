-- PR-B2 · everyday hooks (owner decision 7) — a one-time backfill, no schema.
--
-- Decision 7: the allowances own the everyday reserve, and the "Weekly Spend" /
-- "Monthly Spend" bills become DATE HOOKS — the forecast replaces each of their
-- occurrences with the card payoff (charges + remaining allowance) and ignores
-- the stored amount. Which items are the hooks lives in the owner's
-- `settings.preferences.everydayHooks`:
--     { "weekly":  { "recurringItemId": "<uuid>" } | null,
--       "monthly": { "recurringItemId": "<uuid>" } | null }
-- (a server-owned key: a settings PUT never writes it).
--
-- The match is EXACT: an ACTIVE recurring item of the household named exactly
-- 'Weekly Spend' (weekly hook) or 'Monthly Spend' (monthly hook) — the names
-- the seed defaults write. Case, spacing and every other name are left alone;
-- a household with neither item gets no key at all. With two active items of
-- the same name, the oldest (created_at, then id) is the hook.
--
-- Idempotent: only a settings row that does not already carry the key is
-- written, so running it again — or after the owner's hooks changed — writes
-- nothing. A row whose preferences are not a JSON object is treated as {}.
UPDATE settings s
   SET preferences = (CASE WHEN jsonb_typeof(s.preferences) = 'object' THEN s.preferences ELSE '{}'::jsonb END)
       || jsonb_build_object(
            'everydayHooks',
            jsonb_build_object(
              'weekly',
              (SELECT jsonb_build_object('recurringItemId', r.id::text)
                 FROM recurring_items r
                WHERE r.household_id = h.id AND r.active = 'true' AND r.name = 'Weekly Spend'
                ORDER BY r.created_at, r.id
                LIMIT 1),
              'monthly',
              (SELECT jsonb_build_object('recurringItemId', r.id::text)
                 FROM recurring_items r
                WHERE r.household_id = h.id AND r.active = 'true' AND r.name = 'Monthly Spend'
                ORDER BY r.created_at, r.id
                LIMIT 1)
            )
          ),
       updated_at = now()
  FROM households h
 WHERE h.owner_user_id = s.user_id
   AND NOT (CASE WHEN jsonb_typeof(s.preferences) = 'object' THEN s.preferences ? 'everydayHooks' ELSE false END)
   AND EXISTS (
         SELECT 1 FROM recurring_items r
          WHERE r.household_id = h.id AND r.active = 'true' AND r.name IN ('Weekly Spend', 'Monthly Spend')
       );
