# CLAUDE.md — Engineering guardrails for H2 Budget

Standing rules for all work in this repo. Read before changing anything. These
override convenience: when a rule and a shortcut conflict, the rule wins. If a
task seems to require breaking one, **stop and ask.**

H2 Budget is a personal/family budgeting app (pnpm monorepo). Its single goal is
to get the household out of debt; correctness and trust beat everything.

---

## 1. Money & correctness (non-negotiable)

- **This app contains NO AI.** No advisor, no generated narratives, no LLM
  calls anywhere — every number and every word on screen is computed or
  written in our code. Do not re-add AI features (removed 2026-08).
- **Never change financial calculations, queries, or stored data values** while
  doing UI, routing, performance, or copy work. UI consumes existing hooks/data
  unchanged. If a change genuinely requires touching financial logic, **stop and
  ask first.**
- After any change that could affect displayed numbers, **confirm no financial
  totals changed.**
- **The north star is being out of debt.** Judge features by payoff impact.
  Landing-facing surfaces show **% paid, never the amount owed** — the spine is
  tested to refuse to carry a balance at all (see §3, spine law).

## 2. Data fetching & performance (hard rules)

- **Never fetch unbounded transaction lists.** Every `/api/transactions` query
  must be scoped with `from`/`to` and a **small `limit` (default ≤ 100** for
  list views). Summary/aggregate pages request **server-computed aggregates**,
  not raw rows. **The `limit=5000` pattern is banned.**
- **Every `useQuery` has an explicit, sensible `staleTime`/`gcTime`.** Slow-
  changing data (settings, version, mapping-rules, forecast)
  gets a **generous `staleTime`** so navigation doesn't refetch.
- **No duplicate or overlapping queries** for the same data. Global / slow-
  changing data is fetched **once at app level** and reused, not per page.
  Normalize query keys so identical data never loads under two keys.
- **Prefer stale-while-revalidate:** render cached data immediately, revalidate
  in the background. **Skeletons are for genuine cold loads only.**
- **Prefetch** a route's primary queries on nav-link **hover/focus** or on idle.
- **The open path is budgeted, and CI enforces it.**
  `node scripts/check-entry-graph.mjs` fails the build if recharts reaches a
  preloaded chunk, if react-dom lands outside `vendor-react`, or if landing JS
  exceeds its cap. **Never add a chart to the open path.** Charts are lazy, in
  `vendor-charts`, and never imported by anything the landing route pulls in.
- `routePrefetch.ts` and `App.tsx` move in lockstep on any route change.

## 3. UI consistency — the design system

The look is the **KFI Financial Dashboard language**: navy + orange, platinum
surfaces, flat and matte, one typeface, quiet motion. There is one kit, and it
is small. Reuse it; do not invent a second one.

### Where the kit lives

- **`src/ui.tsx`** — the page furniture. Class-string tokens (`card`,
  `cardHead`, `btn`/`btnSecondary`/`btnDanger`/`btnLink`, `input`, `fieldLabel`,
  `th`/`td`/`tdNum`, `errorBanner`, `emptyNote`) and components (`Page`,
  `Stat`, `Field`, `Help`, `Note`, `Foot`, `Crumbs`). **Cards use `card` +
  `cardHead`; tables use the `th`/`td`/`tdNum` trio; stat rows use `Stat`.**
- **`src/lib/chartTokens.ts`** — the palette and pure chart maths, deliberately
  dependency-free (`CHART`, `CAT8`, `OTHER_GREY`, `NAVY_RAMP`, `rampByRank`,
  `catColor`, `niceAxis`, `compactUSD`, motion presets). Import charts from
  `@/lib/charts`, which re-exports all of it.
- **`src/lib/charts.tsx`** — the recharts kit (`LineTrend`, `HBar`, `Donut`,
  `useXTicks`, `PointLabels`). Lazy-loaded only.
- **`src/lib/cssBars.tsx`** — `CssBars` and `CssFillMeter`. **Hover-scrubbed
  lists are CSS bars, never recharts**: recharts restarts its draw animation on
  every data-reference change, so a hover-driven list strobes.
- **`src/index.css`** — every design token: the `@theme` palette, the 6-step
  type scale, two radii, three elevations, the motion dials, and the **bridge
  layer** that rebinds shadcn's HSL variable *names* to navy/platinum values so
  the surviving `components/ui/*` wrappers inherit the palette for free.
- **`src/components/viz/*`** — small SVG primitives (`Sparkline`, `MiniBars`,
  `StackBar`, `RingStat`, `DeltaPill`, `MoneyText`).

### The laws

- **Navy + orange only.** Every colour on screen ∈ {navy `#19315b` / `#22406e`,
  orange `#f68d2e`, deep orange `#e16d3e`, the platinum ramp, `NAVY_RAMP`,
  `CAT8`, neutral greys, white/black}. **`#f68d2e` is the accent; `#e16d3e`
  means something is wrong** — never swap them.
- **Zero banned Tailwind colour utilities.** No `red-*`, `green-*`,
  `emerald-*`, `amber-*`, `blue-*`, `teal-*`, … and **no arbitrary colour
  literals** (`bg-[#abc123]`). If you need a colour, add a token in `index.css`
  and use the generated utility. An escape-hatch hex is invisible to every
  palette grep.
- **No colour aliases.** There is no `primary`/`teal`/`danger` name pointing at
  a hex that another name also points at. Aliases are how two series read as two
  colours while drawing one pixel. `chartTokens.test.ts` asserts this.
- **Status is never colour alone.** The label says the state. Good is the same
  navy as body text on purpose — good is the resting state and should not shout.
- **Sequential data uses `NAVY_RAMP` indexed by RANK** (`rampByRank`), never by
  series. Categorical identity uses `CAT8`, capped at 8, tail rolled into
  `OTHER_GREY`.
- **Mono numerals everywhere money or a count renders** — `font-mono
  tabular-nums` (`tdNum` and `Stat` already do this). Digits that don't line up
  are the loudest "nobody designed this" signal on a financial screen.
- **One type family (Inter Variable, self-hosted) and the 6-step scale only.**
  No ad-hoc font sizes. `--text-hero` is reserved for THE ONE number a screen
  exists to answer; a screen gets one or none.
- **Dark mode does not exist.** No `dark:` variants, no theme toggle.
- **Word diet.** No sentence where a label works; explanations demote to a
  `Help` chip. Zero exclamation marks, zero cute copy.

### Motion — two curves and four dials

- Dials in `index.css :root`: `--anim-speed` (2.2), `--dur-press`, `--dur-in`,
  `--dur-page`, `--stagger`. Durations are written as
  `calc(<base> * var(--anim-speed))` so the whole system moves on one knob.
  **Keep `--anim-speed` equal to `SPEED` in `chartTokens.ts`.**
- Two curves, and they mean different things: **`--ease-enter`** (gentle
  ease-out) for things ARRIVING, **`--ease-move`** (symmetric) for anything
  TRAVELLING — a bar growing, a line drawing, a row re-ranking.
- ⚠️ **The reduced-motion switch has two halves and both are load-bearing.**
  The dial overrides MUST stay **unlayered and below the base `:root`**:
  unlayered CSS beats layered CSS outright, so a `:root` inside `@layer
  utilities` is silently dead. The `!important` keyframe kills are NOT
  redundant — `.stagger`'s per-child delays and `.skeleton`'s sweep are literal
  durations no dial can reach. `index.css.test.ts` pins both halves.
- Recharts animates in JS, where CSS media queries can't reach it, so
  `chartTokens.ts` gates it separately via `PREFERS_REDUCED_MOTION`.

### ⭐ The spine — one snapshot, many surfaces

`GET /api/spine` computes the shared household snapshot server-side in one pass
(bank roll-forward, spend windows, next bill, forecast low point/runway, debt
payoff %, review count). Every field is produced by **the same function the
owning page's endpoint calls** — never reimplemented.

- **Any number the spine carries is read from `useSpine()`, never recomputed
  locally.** A page that re-derives its own copy is how two tiles come to
  disagree, which is exactly what this endpoint exists to make impossible.
- **The parity contract is tested, not hoped for.**
  `api-server/src/__tests__/spineParity.integration.test.ts` asserts each spine
  field equals its owning endpoint **to the cent**, and asserts the spine never
  carries a debt balance or amount owed. If you add a spine field, add its
  parity assertion in the same PR.
- Mutations invalidate the spine centrally through the `mutationCache` in
  `App.tsx` — not with thirty hand-written invalidations.

### Other UI rules

- **User identity/name comes from a single source of truth** (Clerk
  `user.firstName`). No "Brad" vs "Hannah" drift; user-facing copy stays
  name-neutral or uses that one source.
- **No route may render a blank screen.** Unfinished/loading routes show a
  placeholder or skeleton **inside the shared layout**, never a white page.
- **Voice (UI microcopy):** serious, supportive, professional — calm, clear,
  genuinely helpful. **No sass, no profanity, no roasting** (the owner
  explicitly reversed the earlier savage voice in 2026-07). Tie copy to real
  numbers and next actions; frame partial periods as "so far".
- **Send-to-Forecast is a single flow.** Sent = in review = on the curve. Never
  re-add a separate review gate.

## 4. Workflow

- **Branch per task; PR per task.** Never commit directly to `main`; never
  force-push. Keep PRs small and focused.
- After each change run **typecheck + build** (and tests where they apply); CI
  must pass. **Wait for review before merge.**
- New/changed API: edit `lib/api-spec/openapi.yaml`, run codegen, implement the
  route, consume the **generated** hook. Never hand-write client hooks. The
  committed generated `api-zod`/`api-client-react` must match the spec (codegen
  is not in the deploy build).
- **Commit `pnpm-lock.yaml` on any dependency change**, regenerated with pnpm
  10.34.3 exactly.
- **Adding a dependency needs a named justification.** The overhaul removed
  dozens; the entry-graph guard exists because weight is a feature here.

---

## Repo quick reference

- **Stack:** pnpm workspaces, Node 24, TS 5.9. API = Express 5 + Drizzle +
  PostgreSQL + Zod + Orval. Web = React + Vite + TanStack Query + wouter + Clerk.
- **Packages:** `artifacts/api-server` (Express `/api/*`), `artifacts/h2budget`
  (web UI), `lib/api-spec` (OpenAPI), `lib/api-zod` + `lib/api-client-react`
  (generated), `lib/db` (Drizzle schema), `lib/avalanche-core` (shared payoff
  maths).
- **Commands:**
  - `pnpm run typecheck` — singleton-dep check + typecheck all packages (the green gate)
  - `pnpm run build` — typecheck + build every package
  - `node scripts/check-entry-graph.mjs` — open-path weight guard (run after a build)
  - `pnpm --filter @workspace/api-spec run codegen` — regen API hooks + Zod
  - `pnpm --filter @workspace/db run push` — push DB schema (dev only)
- **Tests:** `pnpm --filter h2budget exec vitest run` (web, jsdom) and
  `pnpm --filter api-server exec vitest run` (API integration — needs a real
  Postgres and `DATABASE_URL` + `ALLOW_TEST_DB=1`). Parallel agents must use
  **separate test databases**; several Plaid tests use the real clock and
  contend.
- **Deploy:** GitHub `main` is the source of truth; **Render** auto-deploys
  `main` (single Web Service `h2budget` serving SPA + `/api`, health check
  `/api/healthz`, live at https://h2budget.onrender.com). Pinned
  `packageManager: pnpm@10.34.3`, Node 24. Verify `/api/version` matches the
  merge SHA after deploy. (Replit remains only as a dormant rollback.) Never
  deploy unreviewed work.
