# AI-3 — proactive monitoring: findings, deterministic detectors, the monitor job, the agent's run / action trail

- **Branch:** `reinvent/ai3-monitoring`, cut from `origin/main` at `5fe57ec2` (PR-0, AI-0, S0, PR-B1 merged).
- **Package:** AI-3 of the 2026-10-07 reinvention plan. **No model call anywhere in this package**: every finding is
  deterministic code over money facts.
- **All figures below are synthetic test fixtures.**

## The owner's decision

CLAUDE.md §1, as amended 2026-10-07: code computes every figure; a model may classify, extract, draft or propose, never
write money. The monitor goes one step further for now — it needs no model at all. It reads the same facts the Today
screen reads (the money position, the bills, the budget, the last 72 hours of rows, the bank's freshness), runs six pure
detectors, and records what is new. A finding carries ids and numbers; the Activity trail says what happened and when.

## What changed

**Tables** (drizzle `lib/db/src/schema/agent.ts`; SQL `0030_agent_runs.sql`, `0070_agent_findings.sql`; idempotent,
additive; `agentSchemaParity.integration.test.ts` runs both files twice in a scratch schema and compares columns,
indexes, checks, unique constraints and foreign keys with what `drizzle-kit push` builds)

- `agent_runs` — one row per agent run (`kind` chat / categorize / monitor / recap / receipt / sms_question, `trigger`,
  `status`, tokens, cost, a `summary` capped at 300 characters by a CHECK, `job_id` unique). **AI-1 reuses it.**
- `agent_actions` — one row per thing the agent did (the Activity screen): `type`, target, `before` / `after`, `outcome`
  (applied / proposed / needs_attention), `reversible`, `undone_at` / `undone_by`. **AI-1 reuses it.**
- `agent_findings` — what the monitor noticed; unique `(household_id, dedupe_key)`.
- Indexes: the plan said `(household_id, started_at desc)`. Drizzle emits `DESC NULLS LAST` for a descending index,
  which is a different index from a plain `DESC` in SQL, so the two could not be made to agree. The indexes are plain
  ascending `(household_id, started_at)` / `(household_id, created_at)` / `(household_id, last_seen)`; a btree is read
  backwards for free, so the "newest first" queries use them.

**Detectors** (`src/monitor/detectors/*.ts`; each a pure `(MonitorFacts) → Finding[]`)

| Kind | Fires when | Severity / confidence | Dedupe key |
|---|---|---|---|
| `bill_increase` | an active, non-debt-linked bill's latest paid amount > 1.10 × the median of its previous 3–6 amounts **and** more than $5 above it | watch · `confirmed` if the latest is a matched row, `estimate` if a tier-2 pair | `bill_increase:<itemId>:<latest cents>` |
| `category_acceleration` | month-to-date spend ÷ elapsed days × days in month > 1.25 × the category's planned line, with ≥ 10 days left | watch · estimate | `category_acceleration:<categoryId>:<YYYY-MM>` |
| `shortfall_before_income` | `position.availableUntilPayday` is exactly 0 and `lowestUntilPayday` < `cashBuffer` | high · `estimate` when `position.confidence = estimated` or `degraded`, else confirmed | `shortfall_before_income:household:<horizon end>` |
| `duplicate_charge` | two posted outflows, same merchant signature, amounts within $0.01, ≤ 72 h apart, different ids, no refund (inflow of the same signature and amount) in the window | watch · estimate | `duplicate_charge:<idA>.<idB>:pair` |
| `limit_near` | `0 ≤ remainingWeek ≤ 15%` of the weekly cap (over the cap is the Today meter's job) | info · confirmed (estimate if degraded) | `limit_near:household:<week start>` |
| `bank_stale` | freshness verdict stale **and** quiet more than 72 h (or unknown) | watch · confirmed | `bank_stale:household:<week start>` |
| `goal_behind` | **not built** — the goals table arrives in PR-C. The kind stays in the enum and the CHECK, so PR-C adds a detector, not a migration. **TODO (PR-C).** | | |

Boundaries are exact: integer-cent comparisons (`latest × 10 > median × 11`, `spent × days × 4 > planned × 5 × day`,
`remaining × 100 ≤ cap × 15`), and each has a "fires / does not fire one step inside" test.

Three guards the brief did not list, each a named constant and each a deliberate choice (say the word and they go):

- `category_acceleration` skips a category that an active bill sits in (rent paid on the 1st reads as a huge pace
  forever; `bill_increase` watches bills) and a line under $20.
- `bill_increase` skips debt-linked bills (a card minimum moves with the balance; it is not a price increase).
- `duplicate_charge` ignores amounts under $5 (two coffees are not a double charge).

**Facts** (`src/monitor/facts.ts loadMonitorFacts`) — one read: the cash signal and freshness (once), handed to
`buildMoneyPosition`, so a finding cannot disagree with the spine; this month's and the trailing three months' spend by
category (`buildSpendingFacts`); this month's `budget_lines`; recurring items; the last confirmed `matched`
`forecast_resolutions` per bill (a `partial` is a partial payment and is never read as the bill's amount) plus the
ledger's tier-2 pairs; the posted, non-transfer rows of the last 72 h (descriptions become a merchant signature in
memory and are dropped). Read-only, no Plaid call.

**Dedupe and cooldown** (`src/monitor/store.ts`, pure `decideFinding` + one transaction)

- no row → insert (new) · unresolved row → bump `last_seen`, figures, and any rise in severity (not new).
- resolved row → stays quiet; re-fires (new) only when its severity rose or it was resolved more than 7 days ago.
- A finding the detectors no longer produce is **auto-resolved** (its cause cleared). Not in the brief; without it a
  cleared shortfall would sit in the open list forever, and the 7-day cooldown is what stops a flapping condition
  re-alerting every night. Only the kinds that ran are auto-resolved, only for the household that ran.

**Job** (`src/jobs/handlers/monitor.ts`, queue `monitor.household`)

- `{ householdId, ownerUserId }` → `runMonitor(householdId)`: an `agent_runs` row (kind monitor), findings upserted,
  one `agent_actions` row per NEW finding (`needs_attention` for high, else `applied`), summary like
  `3 findings, 1 new`. Idempotent: a second pass over unchanged facts changes no finding and writes no action (only its
  own run row); a retry of the same pg-boss job finds its run by `job_id`.
- Per-household send options (`monitorSendOptions`): `singletonKey mon:<household>`, `singletonSeconds 600`,
  `expireInSeconds 300`, `retryLimit 2`.
- **Schedule:** one pg-boss schedule on the queue, `15 2 * * *` `America/Chicago`, data `{ fanout: true }`. Its handler
  enqueues one per-household job for every household with a Plaid item. One schedule however many households there are,
  so no schedule table to keep in step with the households.
- **Chaining from `txn.arrived` — deliberately not wired here.** PR-A adds the `txn.arrived` emit at the end of
  `syncPlaidItem`; this package adds nothing to `plaidSync.ts`. Once PR-A lands, the follow-up is one line in its
  handler: `await enqueueMonitor(householdId, ownerUserId, "txn_arrived")` (exported from the monitor handler; it carries
  the singleton options, so a burst of syncs is one run per 10 minutes).

**Endpoints** (`routes/agent.ts`; OpenAPI + codegen; all `requireAuth`, household-scoped; another household's row is a 404)

- `GET /agent/findings?status=open|all&limit≤50` (open = unresolved and undismissed; newest first)
- `POST /agent/findings/:id/dismiss` · `POST /agent/findings/:id/resolve`
- `GET /agent/runs?limit≤30` · `GET /agent/actions?limit≤50` (the Activity trail)
- `POST /agent/actions/:id/undo` — 404 not in this household; 409 not reversible or already undone; 501 for a reversible
  type whose undo has not shipped (`set_category` arrives with AI-1; nothing is reversible today)
- `POST /agent/monitor/run` — the household **owner** only (403 for a member); runs it now, trigger `user`.

## Figures that move

None. New tables and new endpoints only. No existing query, calculation or stored value changed. `schema/index.ts`
gains one `export *` line; `routes/index.ts` one router; `jobs/register.ts` one `work` and one `schedule`.

## Must not change (held)

- The money position, the spine and every existing route — the monitor only reads them.
- `plaidSync.ts` — untouched.
- No raw merchant string in any `summary`, `payload`, action or log: test greps the stored rows for the merchant text
  and signature of the synthetic charges.
- No amount is ever written, and no budget or goal is raised; the monitor writes only `agent_*` rows.

## Tests

- `monitorDetectors.test.ts` — every kind: fires and does not fire at the boundary (+ cents, +$5, 72 h, 15%, 10 days);
  `decideFinding` dedupe, the 7-day cooldown on both sides, the severity-rise re-fire.
- `monitorRun.integration.test.ts` — run / actions / findings written; run twice → findings and actions unchanged and
  one more run; cooldown and re-fire; dismissed stays quiet; auto-resolve touches only its own household; failure marks
  the run failed (error ≤ 300) and rethrows; no merchant string anywhere; job retry by job id (finished and failed);
  the daily tick enqueues one job per Plaid household with the singleton options.
- `monitorFacts.integration.test.ts` — the loader on a real synthetic household (confirmed bill payments, a `partial` not
  read as an amount, transfers and pending rows left out, another household's rows never leak) and a real run on top.
- `agentRoutes.integration.test.ts` — shapes, limits (51 → 400), dismiss / resolve, owner gate, household isolation on
  every route, undo 404 / 409 / 501.
- `monitorSchedule.integration.test.ts` — pg-boss on: one schedule `15 2 * * *` `America/Chicago` with `{fanout: true}`;
  a second per-household job inside 10 minutes is dropped; the job carries `retryLimit 2`, `expireInSeconds 300`.
- `agentSchemaParity.integration.test.ts` — SQL ≡ drizzle, twice-run idempotent.
- **Fails before:** run against the parent (`5fe57ec2`, the new modules and tables absent) every one of these files fails
  at import / on the missing tables.

## Gates

| Gate | Result |
|---|---|
| `pnpm run typecheck` | exit 0 (libs, api-server, h2, classic incl. e2e, scripts) |
| Codegen drift | none (re-running `api-spec codegen` changes nothing) |
| API suite (real Postgres, serial) | **180 files, 1854 passed**, 13 todo, 0 failed |
| New files fail against the parent | 5 of 5 fail (modules absent), pass here |
| h2 web suite | 16 files, 169 passed, 4 skipped |
| Classic web suite | 140 files, 1248 passed, 4 skipped |
| `pnpm run build` | exit 0 |
| Entry-graph guard, classic | OK, 576.1 KB of 580 KB (unchanged: no web code touched) |
| Entry-graph guard, h2 | OK, 352.2 KB of 400 KB |
| `pnpm audit --prod` | 3 findings (1 critical `proxy-addr` via express, 2 high `braces`, `compression`), all pre-existing on main; `pnpm-lock.yaml` is byte-identical, no dependency added |

## Residuals

- `goal_behind` — PR-C (goals table). Nothing else is deferred in the detector set.
- Chain from `txn.arrived` once PR-A is merged (one line, above).
- `agent_actions.undo` is a stub that answers 409 / 501 until AI-1 makes `set_category` reversible and implements it.
- Tuning: the thresholds are the brief's; the three guards above are the only additions. After a week of real runs the
  open list shows whether any detector is too chatty (a `limit_near` per week is the loudest by design).
- A finding is surfaced to nobody yet: `surfaced_in_recap_id` is the hook for the weekly recap (a later package) and the
  Activity screen reads `/agent/actions`.

## Questions for the owner

1. Keep the three guards (bill categories and lines under $20 skipped by `category_acceleration`; debt-linked bills
   skipped by `bill_increase`; under-$5 pairs skipped by `duplicate_charge`)? Each is one constant to change.
2. Auto-resolve a finding when its cause clears — keep? (The alternative is that only a person closes a finding.)
