# C0 — shared groundwork (2026-10-09)

Branch `restore/c0-groundwork`, cut from a6b521e9 and rebased onto `origin/main` 82fc8698 (CB1 + B6). Spec: `2026-10-08-parity-verified.md` §8 "C0", items 1–7.
Infrastructure only. No API behaviour change.
No classic route renders differently (measured, below), with one exception that was asked for: on a screen with classic (non-overlay) scrollbars, a page too short to scroll now keeps the scrollbar's gutter.

## 1. Panel variants (`components/next/Panel.tsx`)

- `Panel variant=` takes one or several of:
  - `flush` — no body padding.
  - `sticky-safe` — `.panel-sticky-safe { overflow: clip }`. Clips like `hidden`, but is not a scroll container, so sticky rows inside stick to `<main>`.
  - `static` — no `panel-link` hover lift.
- `ChartPanel({ height = 280 })` — fixed-height, full-width body for a `ResponsiveContainer`. Imports no chart library.
- `TablePanel({ head?, maxHeight?, variant? })` — always flush. Optional column-label row. With `maxHeight` the rows scroll under it.
- A Panel with no variant renders exactly as before (`panel panel-link`, body `p-4`). Tested.
- `/next/accounts` Activity panel is now `["sticky-safe", "flush"]`. The padding moved to a `p-4` wrapper inside it. The embedded Chase/Amex sticky pane bleeds back over that padding (`-mx-4 px-4`), so it spans the panel when it sticks. Embedded mode only; the classic pages are untouched by this.
- Headless check with the built CSS (scrolled 1,500 px):
  - In a plain `.panel` the pane scrolls away (top −1,125 px).
  - In a sticky-safe panel the pane holds at `<main>`'s top (0), and the bulk bar sits right under it (50 px = `--page-sticky-top`).
- Tests: `next.test.tsx` (variants, ChartPanel, TablePanel), `Accounts.test.tsx` (both ledgers sit in a sticky-safe, flush panel with no scroll container between), `index.css.test.ts` (`overflow: clip`, same layer as `.panel` and after it).

## 2. Shell scroll contract

- `<main>` is the only vertical scroller. It now carries `data-shell-scroller` and `.shell-scroller` (`scrollbar-gutter: stable`).
- `index.css` comment fixed: it said `html` is the sole scroller. `html` keeps its rule for screens outside the shell (sign-in, sign-up).
- Published on `:root` (md = Tailwind's 48rem):
  - `--shell-pad-x/-y` — 12 px, 20 px from md. The content column uses `.shell-pad` instead of `p-3 md:p-5`.
  - `--page-sticky-top` — the page's sticky-head height. Chase and Amex set it instead of `--pinned-pane-h`. Forecast sets it from `pageStickyHeaderRef`. Bulk bars, day headers and the pinned inbox use `top: var(--page-sticky-top)`.
  - `--page-head-overshoot` — 4 px, 12 px from md. See below.
- `lib/shellScroll.ts`: `shellScrollerOf(el)` and `offsetWithinScroller(el, scroller)`.
- **Finding: the D18 overshoot is visible.** Measured in headless Chromium with the built CSS (scratch harness, not committed):
  - `sticky` pushes the head back down to `<main>`'s top, so the content under it sits 4 px (phone) / 12 px (md+) higher than a "correct" head would leave it.
  - Past a 1,600 px column the head is 24 px wider than the content.
  - Using the shell pad alone moved every page under those heads by 4/12 px.
- So the heads use `.page-sticky-head` = shell pad + `--page-head-overshoot`. That is exactly the old 16/32 px.
- Same harness after the change, old CSS and classes against new: screenshots are byte-identical on all three pages.
  - Widths 390, 767, 768, 800, 1280, 1640, 1700, 1920. Scroll positions 0, 5, 13, 300, 1,200. Also a page too short to scroll.
- The restyle that owns those pages sets the overshoot to `0px`. That moves the content by 4/12 px, on purpose.
- The forecast's pinned inbox used the same hard-coded bleed. It now uses `.page-bleed-x`.
- Tests: `index.css.test.ts` (values; pad + overshoot = 16/32 px at both sizes; classes built from the variables, in `@layer utilities`; gutter). `shellScrollContract.test.ts` (shell and the three pages use the contract; `--pinned-pane-h` gone). `lib/shellScroll.test.ts`.
- Why utilities, not components: a parent's `space-y-*` writes `margin-block-start` from the utilities layer. A component-layer `margin-top` would lose to it.

## 3. Planned items list (D7)

- `useWindowVirtualizer` → `useVirtualizer({ getScrollElement: () => <main> })`.
- `scrollMargin` is the list's offset inside `<main>`'s content. It is re-measured when that content resizes.
- The virtual box was `totalSize - scrollMargin` tall. virtual-core 3.x already leaves the margin out, so the margin came off twice. It is now `totalSize`.
- Outside the shell there is no scroller to follow, so the list renders in full rather than blank.
- Test: `PlannedItemsList.test.tsx`. It fails on the old code (3 of 3) and passes on the new. Covers a screenful only, following `<main>`'s scroll, ignoring window scroll, box height and the fallback.

## 4. Features sub-module (`@workspace/api-client-react/features`)

- 56 operations tagged `features` in `openapi.yaml`:
  - every F1–F10 route, except the two below and the existing `PATCH /transactions/{id}`;
  - `getMoneyPosition` and `listAllowancePlans`, which F6 reads;
  - `healthCheck`, for F8's `ai.enabled`.
- `listCategorizationReview` stays main-only, because the entry-resident Review badge will read it (F1).
- `aiChat` stays out of both client modules (`ai-stream`).
- `orval.config.ts` has a third client target, the same as the ledger one. The package export is `./features`. Regenerated CI-style, and the output is committed (src + dist `.d.ts`).
- **One difference from chase-ledger:** the main module still carries these operations.
  - The frozen h2 app imports 48 of them from the main module. Excluding them would mean rewriting its imports and changing its live bundle.
  - Main and zod output are byte-identical to before; only the new module was added.
  - At the switch, when h2 is deleted, add `"features"` to the main config's exclude list (one line).
- The dashboard's recap and money-position calls now come from `/features` (`pages/next/dashboard/queries.ts`): `previewRecap` (the fetcher CB1's D14 query calls; `usePreviewRecap` is no longer used anywhere), `useGetMoneyPosition` and `getGetMoneyPositionQueryKey`.
- Guard `src/featuresImportGraph.test.ts`:
  - walks static imports from `main.tsx` (`import()` and `import type` are not edges);
  - asserts nothing on that path imports `/features` or `/ledger`;
  - asserts no h2budget file imports a `features` hook from the main module.
  - Positive controls: `layout.tsx` and `mutationInvalidation.ts` are on the path, and lazy pages are not.
  - Mutation-checked: an added import in `mutationInvalidation.ts` fails both assertions.
- **Landing JS: 578,667 bytes on 82fc8698 → 562,424 bytes on this branch (578.7 → 562.4 KB of 580 KB), −16,243 bytes.**
  - Entry chunk −279 bytes: `previewRecap` and the money-position hook left it. (Before the rebase it was −455: CB1 had since swapped the heavier mutation hook for the plain fetcher.)
  - The virtualizer left the open path: −16,290 bytes net (see "Follow-up: the virtualizer's own chunk").
  - The lasting gain is the guard: the 56 fold-in hooks (≈ 19–21 KB by the parity review's estimate) can now be used without touching the landing chunk.

## 5. Ported helpers

- `lib/money.ts`:
  - `fmtMoney(amount, { whole? })`. Null, undefined, `""` or unreadable gives "—".
  - Every readable amount prints exactly as `formatCurrency` does (tested against it). Never prints "-$0.00".
  - `whole: true` is h2's whole-dollar rounding (half away from zero, through integer cents).
  - Also `toAmount`, `wholeDollars`, `centsValue`, `MISSING`.
  - The h2 tests are ported, plus a parity test against `formatCurrency`.
- `lib/dates.ts`: h2's `lib/dates.ts` unchanged, with its tests (`longDate`, `shortDate`, `shortDateOfInstant`, `relativeTime`, `weekdayDate`, `dayWord`).
- Two-action toast:
  - `use-toast` takes `secondaryAction`. The Toaster lays two actions side by side; one action renders exactly as before.
  - `toastWithActions({ title, description, actions: [a] | [a, b] })` builds the buttons (`components/ui/action-toast.tsx`).
  - Test: `action-toast.test.tsx`.

## 6. Recharts through the kit

- `lib/charts.tsx` re-exports the raw primitives as `Rc*` (`RcLineChart`, `RcTooltip`, …, plus prop types).
- `reportsShared.tsx` and `account-page/balance-trend-chart.tsx` import them from `@/lib/charts`, aliased to their old local names, so no JSX changed.
- The test stub gained the six primitives it lacked.
- Guard `lib/chartsDoor.test.ts`: only `lib/charts.tsx` imports recharts, plus one named exception.
  - The exception is `ProjectedBalanceChart.tsx`: 17 forecast tests stub recharts with their own lists. It moves in C13.
  - The guard also checks that the stub covers every primitive the kit takes.
- Bundle: landing unchanged by this item; recharts stays in the lazy `vendor-charts`. The reports chunks and `vendor-charts` are byte-identical. The shared account-page chunk grew 36 bytes (the import aliases).

## 7. Test policy

> **A stale e2e spec is repaired in the PR that restyles its page, and a stale spec is never counted as a passing parity check. Until the e2e suite is repaired and switched on in CI, the unit suite (UTC + America/Chicago) is the only real gate.**

## D14 — fixed on main by CB1, not here

- At a6b521e9 the recap preview was a mutation, so `meta` + `staleTime` was not a one-liner. C0 left it alone, as instructed.
- CB1 (935294ea) landed meanwhile and made it a cached query (`previewRecap`, 10 min, `OWN_INVALIDATION`, no retry).
- The rebase kept CB1's query unchanged. Only its import moved: `previewRecap` is a `features` operation, so it comes from `/features`. The guard test would fail it from the main module.

## Gates

- `pnpm run typecheck`: clean.
- Codegen (CI style: remove dist and tsbuildinfo, then run codegen), after the rebase: no drift. Main, ledger and zod output match main's exactly; only `features` is new.
- h2budget vitest, 163 files: UTC 1,405 passed, 3 skipped. America/Chicago 1,406 passed, 2 skipped (the zone-specific skips).
- `pnpm run build` + `node scripts/check-entry-graph.mjs`: 562.4 KB of 580 KB, no recharts on open, react-dom confined to `vendor-react`, virtualizer off the open path.
- Frozen h2: no source change and no change to the generated main module. Its guard passes at 399.9 KB of 400 KB.
- `pnpm audit --prod`: 1 high, already ignored in the audit config (same as B0). No dependency changed.
- Classic e2e: not run (not required).

## Follow-up: the virtualizer's own chunk (asked for after the first review)

- `vite.config.ts` used to send every `@tanstack` module to `vendor-query`, which loads on open. Only lazy pages use the virtualizer, yet it cost the open path 16.3 KB.
- `@tanstack/react-virtual` and `virtual-core` now go to `vendor-virtual` (16,340 bytes, lazy). That rule sits ahead of the `@tanstack` one.
- `vendor-query`: 52,824 → 36,492 bytes.
- `check-entry-graph.mjs` check (d) fails when:
  - any landing chunk is `vendor-virtual-*` or carries the virtualizer's code;
  - any built chunk other than `vendor-virtual-*` carries it (the rule drifted);
  - `vendor-virtual-*` no longer matches the fingerprint (the check went vacuous).
- The fingerprint is virtual-core's own option defaults (`isScrollingResetDelay` + `useScrollendEvent`). Call sites never contain them; `getVirtualItems` also appears in the forecast chunk, so it was not usable.
- Negative control: the previous build fails (d) twice, for `vendor-query` on the open path and for the rule drifting.
- The frozen h2 app has no virtualizer; its guard passes unchanged at 399.9 KB.

## Findings for the lead (not built; outside the seven items)
- `pages/forecast/ProjectedBalanceChart.tsx` still imports recharts directly. 17 forecast tests stub recharts with their own lists. It belongs to C13, and `chartsDoor.test.ts` names it as the only exception.
- `useListCategorizationReview` stays in the main module (the F1 badge). If F1 ends up not reading it from the layout, tag it `features` too.
- At the switch, when h2 is deleted, add `"features"` to the main config's exclude list in `orval.config.ts`.
- On a classic-scrollbar screen `html { overflow-y: scroll }` still draws an empty track beside `<main>`'s inside the shell. This predates C0. Left alone: removing it changes the page width there.

