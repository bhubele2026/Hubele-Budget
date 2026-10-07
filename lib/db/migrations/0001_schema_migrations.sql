-- PR-0 · The migration ledger itself. The runner (src/migrate.ts) creates
-- this table before reading it, so this file is the proof that the
-- preDeployCommand path works end to end: on its first production deploy it
-- applies, records itself, and changes nothing else.
CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
