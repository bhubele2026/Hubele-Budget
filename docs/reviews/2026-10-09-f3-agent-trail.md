# F3 — Agent trail, findings (2026-10-09)

Branch `restore/f3-agent-trail`, base `90ae84ae` (origin/main with F1). Parity doc row F3. No server or spec change. Every hook is from `@workspace/api-client-react/features`.

## What was built
- **"Handled by H2"** panel on Review › Categories (`components/agent/HandledByH2.tsx`, in the lazy `review-categories` chunk): the last 10 agent actions grouped by run and type ("Filed 6 charges"), the time, an "Undone" chip, **Why?** (outcome, whether Undo is available, item count, and a finding's figures; refs hidden) and **Undo** (shows only while an action is reversible and not undone; posts each undoable action; a 501 is the quiet "Undo arrives with the next update."). Empty and failed states are said in words.
- **"Needs attention"** panel on the dashboard (`pages/next/dashboard/AttentionPanel.tsx`, in the lazy `BelowFold` chunk): the monitor's open findings (limit 10) with severity word, a link to the page where it is worked on (`FINDING_LINK`), **Why?**, **Resolve** and **Dismiss**. Nothing open, or no answer yet, draws no panel at all (never a zero); it sits last on the grid and is outside `BELOW_FOLD` (no skeleton), so its arrival moves nothing above it.
- `lib/agentTrail.ts` (+ test): `groupTrail`, `trailTitle`, `FINDING_TITLE`, `payloadLines`, `OUTCOME`, the shared request params and cache options, ported from h2 `trailWords.ts`, `AgentTrail.tsx` and `trailQuery.ts`.

## Capability ids (F3 row) — kept
- GET `/agent/actions` — `agent.test.tsx` "asks for 10 actions…". POST `/agent/actions/{id}/undo` incl. 501 — "Undo posts each undoable action; a 501 is a quiet notice", "Undo on success…".
- GET `/agent/findings` (open, limit 10) — "asks for the 10 open findings…". POST `.../dismiss` and `.../resolve` — same test, plus "a refused dismiss says so and keeps the finding".
- `groupTrail` / `trailTitle` / `FINDING_TITLE` / `payloadLines` — `lib/agentTrail.test.ts` (ported `trailWords.test.ts` plus titles, links, statuses). `OUTCOME` — "Why? opens what is known…".
- GET `/agent/runs` and POST `/agent/monitor/run` (owner) — **not wired**: the row names them but h2's trail never showed runs, and "run the monitor now" is an owner control that belongs with Settings › Automation (F5). Left for that block.

## Overlaps noted (not changed)
- `duplicate_charge` finding overlaps the dashboard "Possible duplicates" row and Settings' duplicate merge; `shortfall_before_income` overlaps the forecast. The finding links to the charges / forecast page. Different sources, left as they are.

## Finding for the lead — landing budget
- Landing JS is **632.1 KB of 633** (main was 629.9: +2.2 KB). The new hooks are used only by lazy chunks, but `getListAgent*`, `useDismiss/Resolve…` and the rest of the `features` module sit in the **entry chunk** (verified by grepping the build: `/api/agent/findings`, `/api/wishlist`, `learned-rules`, `ai/usage` are all in `index-*.js`). Cause: `pages/next/dashboard/queries.ts` (statically reachable from `App.tsx` via the eager dashboard) imports `previewRecap` / `useGetMoneyPosition` from `/features`, which makes Rollup keep the whole module in the entry chunk and retain every export any lazy chunk uses. So every fold-in hook costs landing bytes, contrary to the C0 note. Moving those two imports (and their key function) back to the main module would take the `features` module out of the entry (a separate shared chunk), probably freeing most of ~20 KB, but it contradicts the guard in `featuresImportGraph.test.ts`. Not done here; needs your call before F4/F5+ land.

## Gates
- `pnpm run typecheck` (repo root, as CI): clean.
- h2budget vitest, 191 files: UTC 1,669 passed / 4 skipped; America/Chicago 1,671 passed / 2 skipped.
- Build OK; entry graph OK at 632.1 KB of 633; no recharts on open.
- `pnpm audit --prod`: 1 high, already ignored.
- No browser screenshot in this block.
