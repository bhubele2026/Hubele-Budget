# F1 — Review › Categories (2026-10-09)

Branch `restore/f1-review-queue`, base `2077b109` (= origin/main, "Merge restore/c11b-dashboard-bundle"). Parity doc row F1. No server or spec change (the routes already existed; the `features` module already carried the writes).

## What was built
- Route `/review/categories` (lazy page `pages/review-categories.tsx`; `routePrefetch` and `App.tsx` changed together). Review area ribbon gains a "Categories" tab.
- The queue: oldest first, 20 at a time (`limit=20`), proposal as a dotted "provisional" chip, one line why (`reviewWhy`), flags as words, Accept / Change / Skip, keys j / k / a / c / s (ignored while typing or a dialog is open). A resolved item leaves at once and returns with a notice if the server refuses.
- Two-action toast (C0 `toastWithActions`): "Filed under X. H2 will remember Y." with **Undo** (`POST /category-decisions/{userDecisionId}/undo`, item returns to the queue) and **Apply to N similar** (only when the server reported candidates and the learned rule can be found; nothing moves until pressed). Skip says nothing and has no undo (the server writes no user decision).
- Review badge = forecast review + queue total. The pill and the primary "Review" destination carry the sum; inside the Review area the "Review" tab carries the forecast count and "Categories" the queue. The pill goes to `/review` when the forecast inbox has charges, else to `/review/categories`. A queue that has not answered adds nothing (never claims a zero); an unknown spine still hides the badge.
- Dashboard "Categories to confirm" (D20) now links to `/review/categories` as an in-app link, replacing the temporary link to the old app. The panel shares the queue's single query key (it used `limit=1`, a second key).
- New: `lib/reviewQueue.ts` (`reviewWhy`, `reviewFlags`, `dayHeader`, `titleCase`, `byOldest`, `badgeCount`, `filedWords`; ported from h2 `words.ts` / `activityData.ts`), `hooks/useCategorizationQueue.ts` (main generated module, because the entry-resident layout reads it), `components/review/CategoryPickerDialog.tsx` (grouped, searchable; from h2 `CategoryPickerSheet`).

## Capability ids (F1 row) — kept
- GET `/categorization/review` — kept: `reviewCategories.test.tsx` (limit=20), badge test in `appShell.test.tsx`.
- POST `.../accept`, `/skip`, `/correct` — kept: keyboard test and buttons test (endpoints and `{categoryId}` body).
- POST `/category-decisions/{id}/undo` — kept: "Accept says what H2 will remember and offers Undo".
- GET `/category-decisions` — **not wired**: h2's review screen never called it (only the ledger row sheet did). Left for the ledger/row-detail work (F4 row detail).
- PATCH `/transactions/:id` + `patchLedgerCaches` / `isProvisional` / `decisionId` workaround — **not in this block**: that is the hand-filing path on the ledgers, not the queue. Review queue answers do not use it.
- `reviewWhy` / `reviewFlags` / `dayHeader` — kept: `lib/reviewQueue.test.ts`. `badgeCount` — kept: same test + `appShell.test.tsx` "(F1) the Review badge adds the categorization queue".
- j/k/a/c/s keys — kept: "keyboard: j/k move…", "keys are ignored while typing", "no proposal has no Accept".
- Two-action toast (Undo + Apply to N similar) — kept: "'Apply to N similar' sits beside Undo…"; "no Undo when… no Apply unless…".
- Empty / failed / refused states — kept: `review-empty`, `review-failed`, "an answer the server refuses brings the item back".
- Three queues stay distinct — `/review` (forecast bank match) and the Chase inbox untouched; routes table (`routes.test.tsx`) has a `/review/categories` row.

## Differences from h2
- h2's "Automation" link goes to Settings › Automation (`/settings?tab=automation`).
- Apply-to-similar finds the learned rule by category plus a signature contained in the description (the review item has no merchant signature or rule id); if none is found the button is not offered rather than guessing.

## Gates
- typecheck clean (`pnpm run typecheck`, repo root).
- h2budget vitest, 189 files: UTC 1,653 passed / 4 skipped; America/Chicago 1,655 passed / 2 skipped.
- Build OK; **landing JS 629.9 KB of 633 KB** (was 627.2 on main: +2.7 KB, the layout's queue hook and badge words). Headroom is now 3.1 KB; F3's "Needs attention" panel must stay in the lazy below-the-fold chunk. No recharts on open.
- `pnpm audit --prod`: 1 high, already ignored.
- No browser screenshot taken in this block.
