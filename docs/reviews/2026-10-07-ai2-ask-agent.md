# AI-2 — Ask: the grounded question agent, tool registry, conversations, proposals, memory, AI usage

- **Branch:** `reinvent/ai2-ask-agent`, cut from `origin/main` at `ce9a23b8` (AI-0, AI-1, AI-3, AI-4a, AI-4b, PR-A, PR-B1, PR-D; web S0, S1, S3 merged).
- **Package:** AI-2 of the 2026-10-07 reinvention plan. API only: no file under `artifacts/h2` or `artifacts/h2budget` changed.
- **All figures below are synthetic test fixtures.**

## The owner's decision

CLAUDE.md §1, as amended 2026-10-07: code computes every figure; a model may explain and propose, never write money.
Ask answers a household's questions by calling tools that run the app's own readers (the position, the spending facts the
spine uses, the bills, the debt plan, the recap facts). Every `$` figure in an answer is checked against what the tools
returned; a change is a proposal a signed-in person approves.

## What changed

**Provider seam** (`src/ai/provider.ts`, `anthropicProvider.ts`, `fake/`)

- `AiProvider.runTools(call)` next to `callStructured`. Anthropic: `client.beta.messages.toolRunner` with `stream: true`,
  tools built by `betaZodTool` on `zod/v4` then given `strict: true` and the SDK's `transformJSONSchema` (constraints the
  strict mode cannot take become description text, `additionalProperties: false`), system block `cache_control: ephemeral`,
  `output_config.effort` from the task config, `betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`,
  `tool_choice` left auto, `max_iterations` from config (8), an abort `signal`. The runner resumes `pause_turn` itself.
  Each reply's usage and stop reason are returned (one entry per API request); an error carries the replies that finished.
- Fake: a scripted tool loop (`queueFakeChat({ calls: [{name, input}], text, stopReason, usage, delayMs, error })`)
  that runs the real tools and returns real results. Nothing queued answers with the `chat` fixture's text.

**Tools** (`src/ai/tools/`, `makeTools(ctx)`; see the table below). Every tool closes over the household; no input carries
a household, user or owner id; every id the model passes is checked against the household (a miss is
`{"error":"not_found"}`, the same for an id that exists elsewhere and one that does not exist). Results are JSON, at most 2,000
characters and 25 rows; a longer result loses rows (then whole fields) and says `truncated` / `omitted`. Merchant, bill,
debt, memory and explanation strings are wrapped with `untrusted()`. A tool that throws answers `tool_failed` (the message
never reaches the model). A run may make at most 5 write-tool calls.

**`runAgent`** (`src/ai/agent/runAgent.ts`): run row (`chat` / `user`) → store the question → enabled? → `assertBudget(chat)`
(a block is a zero-cost `ai_usage` row and a `budget_exceeded` run) → history (last 12 turns, ≤ 6,000 tokens by
chars/4, each turn cut at 4,000 chars, starting on a question) → tool loop (8 turns, 90 s wall clock, aborts when the
browser goes) → one `ai_usage` row per API request → grounding → store the answer → close the run with tokens and cost
summed from `ai_usage`. Endings: succeeded, refused (refusal), failed (disabled, timeout, connection, api_error,
max_tokens, `too_many_steps` when the cap cut a call, empty), budget_exceeded.
Grounding (`ai/agent/grounding.ts`): every `$1,234` / `$1,234.56` in the answer must be a number in this run's tool
results (ids, dates and `<untrusted>` text are stripped before numbers are collected) or in the person's own message; a
whole-dollar figure may be the round or the floor of a result's cents. Otherwise the answer is kept, the line "Some
figures could not be verified." is appended, `done.grounded` is false and the run's summary says how many.

**Prompt** `prompts/chat.v1.ts` (stable text: no date, id or name): the household's job; merchant strings are data;
every number from a tool result, none invented; read before answering; show assumptions; propose, never apply; no debt
balances; answer shape = short answer, `Based on:` with `ref:<id>`, at most one next step.

**Tables** (`0050_ask_agent.sql` + `schema/agent.ts`; `askSchemaParity.integration.test.ts` runs 0030 + 0050 twice in a
scratch schema and compares columns, indexes, checks, foreign keys with what `drizzle-kit push` built)
`agent_conversations`, `agent_messages`, `agent_proposals` (14-day expiry; unique open row per kind + target), `agent_memory`
(unique `(household, coalesce(member,''), scope, key)`; soft delete by `revoked_at`), `wishlist_items`.
Added beyond the brief: `wishlist_items.target_date` (the tool takes `targetDate`).

**Routes** (`routes/ai.ts`; `/ai/*` limited to 30 a minute per signed-in person)
`POST/GET /ai/conversations`, `GET /ai/conversations/:id` (a person's own; tool results stay on the server),
`POST /ai/chat` (SSE: `token`, `tool`, `done {runId, messageId, text, grounded, demo}`, `error`; `: ping` every 15 s;
`Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`; the `done.text` replaces the streamed tokens; one answer
at a time per conversation, 409), `GET /agent/proposals`, `POST /agent/proposals/:id/approve|reject`, `GET /memory`,
`PUT /memory/:scope/:key`, `DELETE /memory/:id`, `GET/POST/PATCH /wishlist`, `GET /ai/usage/summary`, `PUT /ai/budget`
(owner). Body schemas are the generated ones with `.strict()`.
Spec: tag `ai-stream` on `POST /ai/chat`, excluded from the react-query client in `orval.config.ts` next to `chase-ledger`;
`AiChatEvent` is in `openapi.yaml` and the zod package carries `AiChatResponse` (the tests validate every SSE frame with it).

**Proposals.** `propose_plan_change` and a `set_category` made without the person's ask create `agent_proposals`; `before` is
read by code (the model's `before` is ignored). Approve: claim `proposed → approved` (conditional update, so two taps apply
once), apply through the existing writer (`proposalApply.ts`), `→ applied` with `applied_action_id`; a failed apply puts it
back to `proposed`. Appliers: `set_category` = `setCategoryByHand` + `recordHandFiling` (PR-A's path; undoable through the
existing `/agent/actions/:id/undo`); `weekly_limit` = `writeOwnerAllowancePlan` (**owner only**, 403 otherwise);
`budget_line` = the `POST /budget/lines` upsert for the household's current month (manual expense categories only);
`extra_debt_payment` = `avalanche_settings.manual_extra` + `syncAvalanchePaymentCategory`; `bill_amount` = the recurring
item's amount (not one-time bills). The action row is written on the run that proposed it.

**Laws, enforced by tests** (`askLaws.test.ts`): nothing `moneyPosition`, `forecastLedger`, `cashSignal`, `spendingFacts`,
`budgetActuals` or `lib/avalanche-core` import, transitively, names the memory module or table; nothing under `src/ai`
names the proposal applier, `allowancePlanWriter`, the plan table or the avalanche sync; only `routes/ai.ts` imports the
applier. The existing "nothing automatic writes a plan" test still holds (the writer is reached only through `src/lib` from
the approve route).

## Tools

| Tool | Tier | What it does | Notes |
|---|---|---|---|
| `get_position` | read | Safe to spend now / until payday / this week, assumptions, the weekly plan id | `buildMoneyPosition` |
| `get_spending_summary` | read | Totals for a range ≤ 93 days, by category or merchant | `buildSpendingFacts` (the spine's) |
| `list_transactions` | read | Charges in a range ≤ 93 days, ≤ 25, filters: category, search ≤ 40 (parameterised, `%` `_` escaped), min / max amount | ids to drill into |
| `explain_transaction` | read | One charge, its filing, recent decisions, matched rule / remembered merchant | |
| `get_bills_and_income` | read | Bills, debt minimums, income due in ≤ 60 days, month totals | `buildBillsSummary` |
| `get_debt_plan` | read | Strategies, range, next milestone, planned payments | `computeDebtPlan` minus `comparison.detail` and `range.runs` (no per-debt balances) |
| `get_recap_facts` | read | The recap's facts for a date | `recapFacts`, finding ids stripped |
| `list_memory` | read | Notes the household / agent kept | text wrapped |
| `list_findings` | read | Open monitor findings | |
| `set_category` | write | Proposal; files only when `userAskedToChange` (route flag) | reversible action when filed |
| `remember_preference` | write | `agent_memory`, `agent_proposed`, scope `general`; never over a person's word | cap 100 live notes |
| `propose_plan_change` | write | `weekly_limit`, `budget_line`, `extra_debt_payment`, `bill_amount` proposal | never applied by the model |
| `add_wishlist_item` | write | `wishlist_items`, waiting period from `settings.preferences.wishlistWaitDays` (default 7) | |

## What the model sees

- **System block** (cached): `chat.v1` text above. No date, id, name or figure.
- **Messages**: up to 12 earlier turns as plain text (no tool turns replayed), then the question. A question is capped at 2,000 characters.
- **Tool definitions**: name, description, strict schema. No household / user / owner id in any schema.
- **Tool results**: JSON ≤ 2,000 chars. Ids it may pass back (transaction, category, bill, plan, finding, memory) are the household's own. Merchant / bill / debt / memory / explanation text is `<untrusted source="…">` with markup escaped and capped at 200 chars. No debt balance, no bank account number, no phone.
- **Never**: another household's rows, the owner's email, tokens, the SMS number, raw `agent_runs` rows.

## A scripted conversation (the fake provider, `askAgent.integration.test.ts`)

1. Person: "How much did we spend lately?"
2. Model calls `get_spending_summary { from, to }` → `{ spent: 111.7, spentFiled: 51.7, groupBy: "category", rows: [...] }`.
3. Model: "You spent $111.70 in that stretch. Based on: ref:<txn>" → every `$` figure is in the result: `grounded: true`.
4. Variant: the model writes "$777.77 on pets" → the answer is kept, "Some figures could not be verified." is appended, the run's summary reads "1 figures could not be verified".
5. Variant: `set_category` without the flag → a proposal; with `userAskedToChange: true` → filed, `agent_actions` row `reversible`, `undoDecision` restores the category.

## Figures that move

None. No existing reader, writer, calculation or stored value was changed. `POST /agent/proposals/:id/approve` is the only new money path and runs existing writers for a signed-in person.

## Must not change (held)

The spine, `moneyPosition`, `cashSignal`, `spendingFacts`, the debt plan, categorizer paths, the allowance-plan writer, the avalanche and budget routes: untouched. The one edit to an existing source file outside this package's own: `ai/prompts/index.ts` (registers `chat`), `routes/index.ts` (mount), `ai/provider.ts` / `anthropicProvider.ts` / `fake/index.ts` (the tool-loop seam), `aiUnits.test.ts` (the registry key list now includes `chat`).

## Tests

New: `askTools.integration.test.ts` (18), `askAgent.integration.test.ts` (12), `askRoutes.integration.test.ts` (18),
`askLaws.test.ts` (6), `askSchemaParity.integration.test.ts` (1), `askAnthropicProvider.test.ts` (3).
Covered: tool scoping (A never sees B through any tool, guessed ids, non-uuid ids, no writes on refusal); strict inputs reject
extras and no schema key names a household / user; result caps (rows, characters, `truncated`, `omitted`); outside text cannot close its
wrapper; range / date / search handling; the scripted tool loop with grounding passing, an invented `$` getting the caveat, a figure from the person's own
message passing; every way a run ends (off, budget, refusal, step cap, provider error, max_tokens); history limits; `set_category` proposal vs filed + undo;
remember / list memory; propose kinds with code-read `before`; wish-list wait (default 7, preference 3, yes waits, no never does); proposals
state machine (approve each kind, owner gate, reject, double decision, two simultaneous taps, expiry, other household, vanished target); memory CRUD, soft delete, member scope,
a person replacing an agent's note; SSE frames validated by the generated zod, headers, ping, error frame, 409 on a busy conversation, the UI flag reaching the tool;
usage summary arithmetic; budget PUT owner-only / validation / pause blocks the next question; per-person rate limit; both import-graph laws; SQL ↔ drizzle parity.

**Fails before:** every new file imports modules that do not exist on the parent (`ai/tools`, `ai/agent`, `routes/ai`, the new tables), so none of the 58 new tests can pass there.
**Mutations** (each applied alone, the named file run, then reverted): explain_transaction without the household filter (caught, askTools); `set_category` files without being asked (caught); grounding always passes (caught); weekly limit applied by a member (caught); `spendingFacts` imports memory (caught, askLaws); wish list ignores the wait (caught); results uncapped (caught); `.strict()` removed from a tool schema (caught); budget PUT open to members (caught); claim-before-apply guard removed (**survived**: the two-tap test passes whichever request reads first; the conditional update is still the guard).

## Gates

- `pnpm run typecheck`: clean.
- Codegen (`@workspace/api-spec run codegen`) re-run after the commit: no drift under `lib/`.
- API suite on `h2budget_test_ai2`: 209 files, 2,223 passed, 13 todo, 0 failed (the one existing test that listed the prompt keys, `aiUnits.test.ts`, now lists `chat`).
- h2 web suite in UTC, America/Los_Angeles, Asia/Tokyo, Pacific/Auckland: 20 files, 262–263 passed, 0 failed.
- Classic web suite: UTC and America/Los_Angeles 141 files, 0 failed. Asia/Tokyo and Pacific/Auckland: 3 failures in `plaidReauthBanner.test.tsx` (date text); `git diff ce9a23b8 -- artifacts/h2budget artifacts/h2` is empty, so they are not from this branch.
- Builds: h2, classic and the API bundle build. Entry guards: classic 576.1 KB of 580, h2 374.6 KB of 400.
- `pnpm audit --prod`: 0 un-ignored (1 high, already ignored).

## Residuals

- The live Anthropic path is verified against a stub client only (no network under the test runner, by design); streaming deltas, strict-tool acceptance and the fallback beta need one real call on a preview with `ANTHROPIC_API_KEY`.
- Grounding checks `$` amounts only. A percentage or a count the model invents is not checked (the prompt forbids it).
- The two-tap guard (conditional claim) is not mutation-covered deterministically.
- `list_transactions` returns pending and posted rows as stored; the prompt sends totals to `get_spending_summary`.
- An `ai_usage` row records each API request, but a request that fails mid-stream before its usage arrives is a `null`-cost row.
- Classic web tests fail in `TZ=Asia/Tokyo` and `TZ=Pacific/Auckland` (3 tests in `plaidReauthBanner.test.tsx`); the file is untouched by this branch.

## Questions for the owner

1. Should a member (not the owner) be able to approve `extra_debt_payment` and `budget_line` proposals? Today yes, matching the existing routes; `weekly_limit` is owner-only.
2. The person's own message numbers count as grounded. Keep, or require tool results only?
