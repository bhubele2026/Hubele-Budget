# C7 — Mapping rules on the new grid, plus learned rules (F2) (2026-10-09)

Branch `restore/c7-mapping-rules`, cut from `origin/main` 7a66786f (C0) and rebased onto ed8c0303 (C1–C5 merged).
Spec: `2026-10-08-parity-verified.md` §2.13 (MR-01…29) and §8 C7, plus F2.
Restyle of `/mapping-rules`. No query, money helper or API change. Every handler, hook, dialog and keyboard path of the page is the same code; the diff to `mapping-rules.tsx` is the import block and the render.

## Composition

- Head: "Mapping rules" (the only heading that names the page) and its `Help`.
- `PageGrid`, in this order:
  - **Add a rule** — `Panel` span-8, static.
  - **Test a description** — `Panel` span-4, static; its `Help` in the head.
  - Focus pill + search — span-12 row (`rules-filter-row`).
  - **Rules by category** — `Panel` span-12, `sticky-safe` + `static` + `flush`. Collapse all and the count in the head (`rule-count`).
    - Holds the page's single `DndContext`: bulk bar, drop strip, the category cards, the `DragOverlay`.
    - Cards in an inner grid: one column, two from `xl` (600–760 px each).
  - **Learned from your corrections** (F2) — `Panel` span-12, static, flush.
- Phone: everything stacks. A rule row puts the pattern on its own line, with the match type and category under it.
- Nested cards are white on `platinum-1`, ring `brand-line`. Tokens only.

## Drag-and-drop: what the layout keeps (parity risks)

- One `DndContext` for the strip and every card. Pinned by `mappingRulesLayout.test.tsx` (a mutation that adds `tile-in` to the panel fails two of its cases).
- The strip is not sticky. The cards are not in a new scroller. dnd-kit still reaches the strip by auto-scrolling `<main>`.
- No entrance animation, transform, filter or containment from the overlay up to the page root. Pinned by a test.
  - The inner grid uses a viewport breakpoint, not a container query: `container-type` applies layout containment, which would anchor the fixed `DragOverlay` to the grid.
  - The Add preview and the test result rise in (`section-enter`). They are not ancestors of the overlay.
- Rows keep dnd-kit's inline transform and take no `press`.
- No new dnd-kit import (the unit tests mock an exact export list).

## Measured, headless Chromium (scratch harness, not committed)

The page inside a copy of the shell's scroll structure, against an in-memory API (25 rules, 15 categories, 5 learned rules). origin/main's page was rendered the same way for comparison.
- Widths 390, 768, 1024, 1280, 1440, 1920: no horizontal overflow, no row control outside its row, strip above the cards, Add and Test side by side from 1024.
- Real mouse drag at 1440 and 1024: a rule from far down the page onto a strip chip that was off-screen when the drag began. The chip lit (`data-drop-over`), PATCH carried the full rule with the new category, and the row then read the new category.
  - The overlay sat at the same offset from the pointer before and after the mid-drag scroll (−48, −28 px). So no ancestor captures it.
- Real mouse drag inside a card: one `POST /mapping-rules/reorder`, only that card's slots changed.
- Touch long-press at 414×896 through CDP (the e2e spec's recipe): drop on a chip, PATCH correct, overlay at the same offset.
- Phone rows, before → after: the pattern was cut to its first letter ("S…"). It now has its own line. Row height 57 → 60 px.
- Three card columns were tried at 1,920 px (cards ~500 px). The category was cut to a few letters, so the grid stops at two.

## Parity — MR-01…29

"e2e" = the spec was read and its selectors are unchanged; it was not run (needs Clerk and a live API).

| ID | Kept — proof |
|---|---|
| MR-01 | kept — hooks unchanged; `mappingRulesLayout` "cards run A→Z…" (no `category-drop-cat-none`) |
| MR-02 | kept — `mappingRulesLayout` "cold load… empty note"; no-match `mappingRulesSearchFilter` |
| MR-03 | still **N** — a failed rules query still reads "No rules yet" (gap; not added in a restyle, see Findings) |
| MR-04 | kept — `mappingRulesAddPromptsBulk`; e2e `mapping-rules-add-bulk-undo`; "Select Category" placeholder unchanged |
| MR-05 | kept — optimistic `onMutate`/rollback code unchanged (render-only diff); writes exercised by `mappingRulesBulkChangeCategory`, `mappingRulesRestoreNoPrompt` |
| MR-06 | kept — `rule-add-preview`, `rule-add-preview-count`; e2e `mapping-rules-add-recategorize-preview` |
| MR-07 | kept — `link-show-rule-matches-add` → `dialog-rule-matches-preview`; same e2e |
| MR-08 | kept — `action-undo-add-rule-bulk`; e2e `mapping-rules-add-bulk-undo` |
| MR-09 | kept — `mappingRulesAddPromptsBulk` |
| MR-10 | kept — `rule-edit-btn-*`, `rule-edit-category-*`, `rule-edit-priority-*`, `rule-save-*`; e2e `mapping-rules-per-category-cards`, `budget-popovers-and-mapping-edit` |
| MR-11 | kept — `rule-edit-preview-*`, `link-show-rule-matches-edit-*`; e2e `mapping-rules-edit-recategorize-preview` |
| MR-12 | kept — `action-undo-bulk-recategorize-edit`; e2e `mapping-rules-edit-undo-roundtrip` |
| MR-13 | kept — `mappingRulesRestoreNoPrompt` |
| MR-14 | kept — **new** `mappingRulesLayout` "MR-14" (Enter + button, winner line, Winner/Match chips, Clear) |
| MR-15 | kept — `mappingRulesSearchFilter`; "N total · M shown" now `rule-count` (`mappingRulesLayout`) |
| MR-16 | kept — `mappingRulesLayout` (A→Z, Uncategorized last, priority order in a card); e2e `mapping-rules-per-category-cards`; `max-h-80` list kept |
| MR-17 | kept — **new** `mappingRulesLayout` "MR-17" (localStorage key, Collapse/Expand all); e2e `mapping-rules-collapsed-persistence` |
| MR-18 | kept — **new** `mappingRulesLayout` "MR-18 / MR-21"; `mappingRulesBulkChangeCategory` |
| MR-19 | kept — `mappingRulesBulkChangeCategory` |
| MR-20 | kept — `rule-bulk-delete` ("Delete selected (N)"), `action-undo-bulk-delete-rules`; e2e `mapping-rules-bulk-delete` |
| MR-21 | kept — **new** `mappingRulesLayout` "MR-18 / MR-21" |
| MR-22 | kept — **new** `mappingRulesLayout` "MR-22" (same-card drop reorders; cross-card, none, self do nothing); real drag in the harness |
| MR-23 | kept — **new** `mappingRulesLayout` "MR-23" (one slot, other cards' slots untouched, ends disabled) |
| MR-24 | kept — **new** `mappingRulesLayout` (`rule-priority-a` = 30) |
| MR-25 | kept — **new** `mappingRulesLayout` "MR-25" (full-body PATCH, own category a no-op); real mouse and touch drag in the harness; e2e `mapping-rules-drag-to-category(-touch)`; undo `action-undo-rule-reassign` unchanged |
| MR-26 | kept — **new** `mappingRulesLayout` "MR-26" (4 px, 200 ms / 8 px, keyboard; pointer target first, else closest); overlay offset measured |
| MR-27 | kept — `mappingRulesFocusHighlight` (ring class unchanged) |
| MR-28 | kept — `mappingRulesFocusPillPersistence`; **new** `mappingRulesLayout` "MR-28" toggle |
| MR-29 | kept — every `onError` toast unchanged (render-only diff) |

E2E: all nine `mapping-rules-*` specs (and the four others that open the page) were read against the new DOM. Every selector they use still renders: the `/mapping-rules/i` heading (now pinned to exactly one), every test id, "Select Category", "Drag a rule onto a category", "Delete selected (N)", "1 rule", the chevron icon classes. None is stale; none needed repair.

## F2 — Learned from your corrections

Hooks from `@workspace/api-client-react/features` only. Pure logic in `lib/learnedRules.ts`. Behaviour ported from h2's `screens/activity/RulesView.tsx`; nothing imported. h2's "Rules you wrote" half is dropped: the panel above is the superset.

- One row per learned rule:
  - merchant (title case) and "Confirmed N times · last Oct 5" (household calendar);
  - category select;
  - "Applies to" select (any account / this account only / similar amounts only);
  - Apply to past charges, Turn off / Turn on, Delete.
- Order: rules that are off go last (with an Off chip). Then the most recently confirmed, then by name. Head: "5 learned · 4 on".
- Narrower scopes are offered only when the rule can take them: an account scope needs an account, an amount scope needs a band. The server refuses the others. (h2 offered all three and showed the refusal.)
- "This account only" names the account with an `AccountChip`. Plaid items are read only when some rule needs it.
- "Similar amounts only" shows its band: "$40.00 to $60.00".
- A rule pointing at a category outside the list still shows that category's name.
- **Apply to past charges is never blind.** The press runs the server's dry run (`?dryRun=true`, writes nothing). It shows "9 past charges will move into Groceries" and up to five of them. Only "File them" writes. A dry run that finds nothing says "No past charges to file."
- Refreshes:
  - A rule edit or delete moves no money. It opts out of the app-wide after-write refresh (`OWN_INVALIDATION`) and refreshes this list only. The dry run opts out too.
  - Filing keeps the app-wide refresh. It also marks the transaction lists, budget months and the review queue stale.
- States: skeleton when cold; "Couldn't load what H2 learned." with Try again (never "nothing learned"); an empty note.
- Toasts in h2's words, on classic's toast.
- Tests:
  - `lib/learnedRules.test.ts` (7).
  - `LearnedRulesPanel.test.tsx` (13): real generated hooks over a stubbed `fetch`, with a QueryClient wired like `App.tsx`. Asserts the wire calls and what each write marks stale.
- Not linked yet: "How filing works → Automation" waits for Settings › Automation (F5, block C8).

## Tests changed

- The six `mappingRules*` page tests each gained one `vi.mock` of the `features` module, through the shared helper (`defaultMappingRulesFeaturesMock`). The helper's main-module stub gained `useListPlaidItems` and two key getters. No assertion changed.
- New: `mappingRulesLayout.test.tsx` (15), `LearnedRulesPanel.test.tsx` (13), `lib/learnedRules.test.ts` (7).

## Bundle

- Landing JS 562.7 KB of 580 KB: 562,688 bytes, against 562,526 on `origin/main` ed8c0303 (built the same way). That is +162 bytes.
  - All of it is in the entry chunk; the three vendor chunks are byte-identical.
  - It is the entry's preload list for the lazy page, which now names its new shared chunks (`Panel`, the `features` hooks, `accountIdentity`).
- recharts not on open; react-dom only in `vendor-react`; virtualizer off the open path.
- The page stays lazy (`mapping-rules-*.js`, 47 KB). The four learned-rule hooks sit in a 2.3 KB shared chunk.

## Gates

- `pnpm run typecheck`: clean.
- h2budget vitest, 168 files, on the rebased tree: UTC 1,459 passed, 4 skipped; America/Chicago 1,461 passed, 2 skipped (the zone skips).
- `pnpm run build` + `node scripts/check-entry-graph.mjs`: OK (above).
- `pnpm audit --prod`: 1 high, already ignored in the audit config (unchanged).
- No API or spec change, so no codegen or API suite.

## Findings for the lead (not built)

- **MR-03** stays a gap: a failed rules query still reads "No rules yet". The learned panel beside it now has a real error state, so the two disagree on one screen. It is a small, separate behaviour change.
- On a phone the rule row was already cramped on main (the pattern showed one letter). C7 fixed it by putting the pattern on its own line.
- A drag inside a card still makes rows in other cards shift while the pointer passes over them: one `SortableContext` spans every card. The drop does nothing, as before. Per-card contexts would stop the shift, but they change the drag structure, so they are not in a restyle.
