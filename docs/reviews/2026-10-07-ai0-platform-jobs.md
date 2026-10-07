# AI-0 — AI platform core + pg-boss jobs

Branch `reinvent/ai0-platform-jobs` off `main` `8148f2a1`. Package AI-0 of the H2 reinvention plan
(`~/.claude/plans/staged-dazzling-dongarra.md`, "AI platform" and "Jobs"). Infrastructure only: no business
prompt, no model call on any request path, no money read or written. AI ships **off** (`AI_ENABLED=false`).

## The owner's decision

The owner asked (2026-10-07) for a reinvented H2 Budget with automatic categorization, a daily SMS recap and
"ask" over the household's own numbers, built on current, verified technology, with cost visibility, versioned
prompts and evals. The plan's law replaces CLAUDE.md's "NO AI" line (PR-0 lands that text): **code computes every
figure; a model may classify, extract, draft or propose, never writes money; every output is validated by code;
calls are bounded and logged with redaction.** Jobs move from one `node-cron` timer to pg-boss on the app's own
Postgres, on the single Render instance.

## What changed

| Area | Files | What |
|---|---|---|
| Dependencies | `artifacts/api-server/package.json`, `pnpm-lock.yaml` | + `@anthropic-ai/sdk`, `pg-boss`, `@opentelemetry/api`; − `node-cron`, `@types/node-cron` |
| Tables | `lib/db/src/schema/ai.ts` (+1 re-export line in `schema/index.ts`), `lib/db/migrations/0010_ai_core.sql`, `lib/db/dist/*` | `ai_usage` (one row per API attempt; index `(household_id, created_at)`), `ai_budget` (25 soft / 40 hard / `daily_caps` / `paused_until`), `ai_task_config` (model, effort, enabled). Idempotent SQL twin for PR-0's runner. No FKs (append-only ledger; value-keyed config) |
| AI core | `artifacts/api-server/src/ai/` | `client.ts` (`anthropic`/`fake` provider, `isAiEnabled()`, global pause, vitest guard against live calls), `config.ts` (six `TASKS`; row → env → defaults, 60 s cache), `prices.ts`, `structured.ts` (`runStructured<T>` → `AiResult<T>`), `budget.ts`, `usage.ts`, `errors.ts` (SDK error → kind), `redact.ts`, `anthropicProvider.ts`, `fake/`, `prompts/` (registry + test-only `ping.v1`) |
| Logging | `src/lib/logger.ts` | redact paths `ai.description`, `ai.text`, `ai.body`, `ai.messages`, `ai.phone`, `sms.to`, `sms.body` (exported as `LOG_REDACT_PATHS`) |
| Jobs | `artifacts/api-server/src/jobs/` | `boss.ts` (`startJobs`/`stopJobs`/`getJobsHealth`; own pool `max: 2`; `PGBOSS_SCHEMA`; `JOBS_MODE`), `queues.ts` (10 queues, shared options, `<queue>.dlq`), `emit.ts`, `register.ts`, `handlers/maintenance.ts` |
| Boot | `src/index.ts` | `node-cron` removed; `const server = app.listen(…)` → `startJobs().catch(log + mark failed)`; SIGTERM/SIGINT → `server.close()` (≤5 s) → `stopJobs({ graceful: true, timeout: 20000 })` → `pool.end()`. Plaid validation block untouched |
| Health / ops | `src/routes/health.ts`, `src/routes/ops.ts`, `src/lib/smsStatus.ts`, `routes/index.ts`, `lib/api-spec/openapi.yaml` + generated `api-zod` / `api-client-react` | `/healthz` → `{ status, version, jobs{mode,started,failedLast24h,dlq}, ai{enabled,configured,provider}, sms{provider,configured} }`; owner-only `GET /ops/jobs`, `POST /ops/jobs/:id/retry` |
| Env | `.env.example`, `render.yaml` (envVars section only) | AI / jobs / SMS variables; `AI_ENABLED "false"`, `AI_PROVIDER anthropic`, `ANTHROPIC_API_KEY` + `AI_REF_SALT` `sync: false`, `JOBS_MODE "on"`, `PGBOSS_SCHEMA pgboss`, commented `AI_MODEL_*` / `AI_EFFORT_*` |

`runStructured` order: AI on? → task on? → `assertBudget` → `client.messages.parse` with
`output_config: { effort, format: zodOutputFormat(schema) }` and the system block `cache_control: ephemeral` →
output that did not decode (`parsed_output` null) or broke the schema = `parse_failed`, **one** retry → `validate(value)`
→ result. `stop_reason: "refusal"` → `refusal` (never retried); `max_tokens` → `max_tokens` (not retried). Every
attempt writes an `ai_usage` row (status, tokens incl. cache fields, cost, latency, request id); a call the budget
blocks writes one zero-cost `budget_exceeded` row. Logs carry task, status, counts and a hashed household ref —
never prompt or answer text.

Budget: month-to-date = Σ `ai_usage.cost_usd` since the UTC 1st; `chat`/`sms_question` stop at the soft cap (25),
every task at the hard cap (40); daily caps per UTC day `{chat 40, categorize 20, recap 3, receipt 15, sms_question 10}`
(override per key in `ai_budget.daily_caps`); `paused_until` stops everything for that household; a household-less
call is refused except `eval_judge`.

## Figures that move

**None.** No financial calculation, query or stored value is touched. The only existing behaviour that changes is
the scheduler of the plaid_sync_attempts prune (same function, same 03:47 UTC, now a pg-boss schedule) and the
`/healthz` body (a superset; `status: "ok"` stays).

## Must not change

- The money layer, the spine, every existing route's output — untouched (API suite green, web bundle byte-identical
  landing chunk set, 575.7 KB).
- Banks still sync only when the owner clicks Sync. `jobs/register.ts` registers no Plaid-calling job; the comment in
  `index.ts` says so.
- A job failure, a pg-boss start failure, or unreadable job tables never stop the server serving and never fail
  `/api/healthz`.
- No model call happens unless `AI_ENABLED=true`, the provider is configured, the task is on, and the budget allows.
  Under vitest a live Anthropic client refuses to build unless `AI_LIVE_TESTS=1`.

## Dependencies added

| Package | Version | Why |
|---|---|---|
| `@anthropic-ai/sdk` | `^0.131.0` (lock 0.131.0) | The model client (`messages.parse`, `zodOutputFormat`, typed errors; `betaZodTool`/tool runner for AI-2). 0.132.0 was published today, inside `minimumReleaseAge` |
| `pg-boss` | `^12.37.0` (lock 12.37.0) | Postgres-backed queue: retries + backoff, DLQ, singleton keys, cron with time zone, SKIP LOCKED — no new infrastructure. Replaces `node-cron` |
| `@opentelemetry/api` | `^1.9.1` (lock 1.9.1) | **Required** peer of pg-boss 12 — `pg-boss/dist/telemetry.js` imports it statically; without it `import("pg-boss")` throws. Zero-dependency API package; telemetry is disabled in our constructor |
| removed `node-cron`, `@types/node-cron` | — | Its one job moved to pg-boss |

Lockfile side effects: `pg` 8.20.0 → 8.23.1 (pg-boss needs `^8.23.1`; `lib/db`'s `^8.20.0` range is unchanged) so
the workspace keeps **one** `pg` and **one** `drizzle-orm` instance (a second drizzle peer variant broke typecheck
with "separate declarations of a private property"). `tsx` stays 4.23.12 (an `add` had moved it to 4.23.15; restored
with the temporary-override method from the 2026-10-02 pins). `check-singleton-deps` 8/8.

zod: the workspace pins zod 3.25.76. The SDK helpers are typed against `zod/v4`, which 3.25 ships as a subpath.
`aiZodHelpers.smoke.test.ts` (written first) proves `zodOutputFormat` and `betaZodTool` accept a `zod/v4` schema —
and that a bare-`zod` (classic) schema is refused. **Every model schema must be built with `import * as z from "zod/v4"`.**

Server bundle `dist/index.mjs`: 7,438,356 B at `8148f2a1` → 9,562,592 B (+2.1 MB, server only).

## Tests (API, real Postgres, serial) + fails-before

62 new tests in 10 files. "Before" = the same files copied onto a clean `8148f2a1` worktree.

| File | Tests | What it pins | `8148f2a1` |
|---|---|---|---|
| `aiZodHelpers.smoke.test.ts` | 3 | SDK zod helpers accept `zod/v4` schemas; classic zod refused | fails (no SDK) |
| `aiUnits.test.ts` | 15 | prices (incl. dated alias, unknown → null), `ref`/`untrusted` escaping + 200 cap, logger redaction, SDK error → kind, prompt registry + `AI_PROMPT_<TASK>`, provider resolution, `isAiEnabled`, vitest live-call guard | fails (no SDK) |
| `aiStructured.integration.test.ts` | 11 | ok + demo label; parse_failed → retry → ok; schema break → retry → fail; validation_failed; refusal not retried; max_tokens; rate_limited/timeout rows with request id; disabled (env and `ai_task_config`); config reaches the call; budget block row; registered fixture | fails (no module) |
| `aiBudget.integration.test.ts` | 10 | UTC month/day starts; Sep 30 23:59:59 spend excluded on Oct 1; soft cap stops chat-class only; hard cap stops all; `ai_budget` caps; `paused_until`; household-less; daily caps incl. blocked rows not counted; `daily_caps` override | fails (no module) |
| `aiConfig.integration.test.ts` | 4 | defaults; env beats defaults; row beats env; 60 s cache window | fails (no module) |
| `aiSchemaParity.integration.test.ts` | 1 | `0010_ai_core.sql` runs twice cleanly and equals the drizzle tables column/default/index for column | fails (no SQL file) |
| `jobsEmit.test.ts` | 4 | off-mode `emit` records, sends nothing; queue catalogue + shared options | fails (no module) |
| `jobsBoss.integration.test.ts` | 7 | start (10 queues + 10 DLQs with options, prune schedule `47 3 * * *` UTC, idempotent start); send/work; `emit` on-mode; singleton dedupe; retry → DLQ (2 attempts, original `failed`) + health counts; prune handler; stop. Schema `pgboss_test`, dropped | fails (no module) |
| `healthz.integration.test.ts` | 3 | full shape, no secret in the body; 200 with null counts when tables are unreadable; sms console default / AI off | fails (no module; old body `{status}`) |
| `opsJobs.integration.test.ts` | 4 | non-owner 403 on both routes; empty report before pg-boss ran; counts + failure (message, no stack); retry → `retry` state; 409 when not failed; 400/404; 503 when jobs stopped | fails (no module) |

## Gates

Node 24.18.0, pnpm 10.34.3, local Postgres 16, DB `h2budget_test_ai0`.

| Gate | Result |
|---|---|
| `pnpm run typecheck` (incl. `check-singleton-deps` 8/8) | pass |
| Codegen drift (CI recipe: `rm -rf` dists → `api-spec codegen` → `git diff` + untracked) | clean |
| `CI=true pnpm --filter ./artifacts/h2budget exec vitest run` | 140 passed, 1 skipped files; 1248 passed, 4 skipped (web untouched) |
| API `pnpm --filter ./artifacts/api-server run test` | **161 files, 1668 passed, 7 todo** (151 / 1606 before + 10 / 62 new) |
| `pnpm run build` + `node scripts/check-entry-graph.mjs` | pass; landing 575.7 KB / 580 KB (173.4 KB gz), unchanged chunk hashes |
| Boot: `node artifacts/api-server/dist/index.mjs`, `PORT=3099 JOBS_MODE=on PGBOSS_SCHEMA=pgboss_boot` | `/api/healthz` → `{"status":"ok","version":"…","jobs":{"mode":"on","started":true,"failedLast24h":0,"dlq":0},"ai":{"enabled":false,"configured":true,"provider":"fake"},"sms":{"provider":"console","configured":true}}`; `/api/ops/jobs` unauthenticated → 401; SIGTERM → "Shutting down" → "Jobs stopped" → exit; schema dropped |
| `pnpm audit --prod` | **3 — identical to `8148f2a1`** (critical `proxy-addr` via express, high `compression` direct, high `braces` via http-proxy-middleware → micromatch). None via the new deps. See residual 1 |

## Residuals

1. **`pnpm audit --prod` is 3, not 0, on `main` itself** (advisories published after the 2026-10-02 pins).
   Fixes: `compression` ^1.8.2 (direct), `proxy-addr` ≥2.0.8 (override; express 5 range allows it); `braces` has **no
   patched version** (all ≤3.0.3) — only removing the `http-proxy-middleware` → `micromatch` path clears it. Left for
   a dedicated security-pin PR so three concurrent branches don't fight over the lockfile.
2. `twilio` is not added here (the plan's AI-0 row lists it; the build brief does not) — AI-4b adds it with its use.
   `/healthz` already reports `sms` from env (`SMS_PROVIDER`, `TWILIO_*` presence only).
3. On success `ai_usage.request_id` is the message id (`msg_…`): the SDK drops the `request-id` header from a
   `parse()` result. API errors record the header id (`req_…`).
4. The structured path does not send the refusal fallback (`fallbacks: "default"` is a beta-endpoint parameter); a
   refusal returns `refusal`. AI-2's beta tool-runner calls should carry it.
5. Daily caps count API requests, so a parse retry spends two. Rows with an unpriced model add nothing to
   month-to-date (warned once per model).
6. Cache-read prices for `claude-sonnet-5-5` ($0.20/MTok) and `claude-haiku-4-5` ($0.10) come from Anthropic's
   current pricing notes; the brief gave only their input/output rates.
7. 0010 runs only once PR-0's migration runner is on `main`. Merging AI-0 first is harmless: AI is off, nothing
   reads the `ai_*` tables unless a model call is attempted, and pg-boss creates its own schema.
8. `render.yaml` still describes the single `node-cron` job in its header comment (outside the envVars section this
   package may touch).
9. The prune was scheduled only when Plaid credentials existed; it is now scheduled always (it is a DB-only delete).
10. The global pause is env `AI_PAUSED` or in-process (`pauseAiGlobally`) — not persisted; fine on one instance.
11. `ai_usage` has no retention yet; `/healthz` now runs one cheap count over the pg-boss job table every 30 s.
12. CLAUDE.md on this branch still says "NO AI" until PR-0 merges (PR-0 owns that file).

## Questions for the owner

1. `AI_ENABLED` is a `value` in `render.yaml`, so a Blueprint sync puts it back to `"false"`. Turn AI on by a small PR
   that flips it, or make it `sync: false` so the dashboard switch sticks?
2. Should structured calls (categorize, recap, receipt) also opt into the server-side refusal fallback? It can bill a
   different model for the rescued call.
3. Daily caps count every API request (a retry counts). Keep that, or count logical calls?
