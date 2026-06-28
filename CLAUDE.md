# CLAUDE.md — Engineering guardrails for H2 Budget

Standing rules for all work in this repo. Read before changing anything. These
override convenience: when a rule and a shortcut conflict, the rule wins. If a
task seems to require breaking one, **stop and ask.**

H2 Budget is a personal/family budgeting app (pnpm monorepo). Its single goal is
to get the household out of debt; correctness and trust beat everything.

---

## 1. Money & correctness (non-negotiable)

- **The AI/advisor model NEVER does arithmetic.** Every dollar figure, %, date,
  and projection shown to a user is computed in **our code** and passed to the
  model as **structured data**. The model only does language, prioritization,
  and judgment. It must never restate or re-derive a figure it wasn't handed.
- **Never change financial calculations, queries, or stored data values** while
  doing UI, routing, performance, or copy work. UI consumes existing hooks/data
  unchanged. If a change genuinely requires touching financial logic, **stop and
  ask first.**
- **Commentary, not regulated advice.** The advisor describes the user's *own*
  data and suggests behavioral nudges ("dining is $X over budget"). It must not
  give individualized investment, tax, or legal advice — refuse those and keep a
  short disclaimer surface.
- After any change that could affect displayed numbers, **confirm no financial
  totals changed.**

## 2. Data fetching & performance (hard rules)

- **Never fetch unbounded transaction lists.** Every `/api/transactions` query
  must be scoped with `from`/`to` and a **small `limit` (default ≤ 100** for
  list views). Summary/aggregate pages request **server-computed aggregates**,
  not raw rows. **The `limit=5000` pattern is banned.**
- **Every `useQuery` has an explicit, sensible `staleTime`/`gcTime`.** Slow-
  changing data (settings, version, mapping-rules, forecast, debrief history)
  gets a **generous `staleTime`** so navigation doesn't refetch.
- **No duplicate or overlapping queries** for the same data. Global / slow-
  changing data is fetched **once at app level** and reused, not per page.
  Normalize query keys so identical data never loads under two keys.
- **Prefer stale-while-revalidate:** render cached data immediately, revalidate
  in the background. **Skeletons are for genuine cold loads only.**
- **Prefetch** a route's primary queries on nav-link **hover/focus** or on idle.

## 3. UI consistency

- **One shared design system.** Reuse the existing primitives — `RingStat`,
  `Sparkline`, `MiniBars`, `StackBar`, `MoneyText`, `stat-tile`, `pill-badge`,
  `kill-stack`, `drill-card`, plus the `components/stat/` kit (`RingMeter`,
  `StatusPill`, `TrendSparkline`, `FillMeter`, `WhyExpander`, `SectionHeader`,
  `Callout`) — and centralized tokens (`index.css`, `lib/statusThresholds.ts`).
  **Do not introduce one-off card/pill/chart styles.**
- **User identity/name comes from a single source of truth** (Clerk
  `user.firstName`). No "Brad" vs "Hannah" drift; user-facing copy stays
  name-neutral or uses that one source.
- **No route may render a blank screen.** Unfinished/loading routes show a
  placeholder or skeleton **inside the shared layout** (`PageSkeleton`), never
  a white page.
- **Voice:** savage, profane, brutally funny — **no-mercy, by explicit owner
  request.** Swearing and hard roasting are encouraged, but aim every shot at
  the **spending and the debt** (receipts, splurges, payoff date), never at a
  person's looks, body, intelligence, or worth; no slurs, nothing sexual. A
  furious coach who's 100% on the household's side, every nudge pointed at
  getting out of debt. (Single source of truth: `advisorVoice.ts` VOICE_SYSTEM.)

## 4. Workflow

- **Branch per task; PR per task.** Never commit directly to `main`; never
  force-push. Keep PRs small and focused.
- After each change run **typecheck + lint + build** (and tests where they
  apply); CI must pass. **Wait for review before merge.**
- New/changed API: edit `lib/api-spec/openapi.yaml`, run codegen, implement the
  route, consume the **generated** hook. Never hand-write client hooks. The
  committed generated `api-zod`/`api-client-react` must match the spec (codegen
  is not in the deploy build).

---

## Repo quick reference

- **Stack:** pnpm workspaces, Node 24, TS 5.9. API = Express 5 + Drizzle +
  PostgreSQL + Zod + Orval. Web = React + Vite + TanStack Query + wouter + Clerk.
- **Packages:** `artifacts/api-server` (Express `/api/*`), `artifacts/h2budget`
  (web UI), `lib/api-spec` (OpenAPI), `lib/api-zod` + `lib/api-client-react`
  (generated), `lib/db` (Drizzle schema).
- **Commands:**
  - `pnpm run typecheck` — typecheck all packages (the green gate)
  - `pnpm run build` — typecheck + build
  - `pnpm --filter @workspace/api-spec run codegen` — regen API hooks + Zod
  - `pnpm --filter @workspace/db run push` — push DB schema (dev only)
- **Deploy:** GitHub `main` is the source of truth; the Replit autoscale deploy
  pulls from it. Pinned `packageManager: pnpm@10.34.3`; the deploy needs the
  `CI=true` env var set. Never deploy unreviewed work.
