# V6 — one Automation screen, and no detours into the classic app

Branch `finish/v6-automation` · base `81b56c28` · UI only (no API, no codegen, no migration).

## What the reviewer found

- No control for automatic categorization anywhere in the new app.
- The one switch ("File new charges for me" on Household) wrote `/me/ui-preferences`, which the server never read.
- Several links sent people to the classic app for things the new app already has.

## What changed

- **`/household/automation`** (`screens/household/Automation.tsx`, words in `automationWords.ts`), one column of hairline sections, all from `GET /categorization/settings`:
  - Filing: "File new charges automatically" (owner; a member sees it disabled with "Owner only") and the engine line.
  - AI: Configured / Not configured; On / Off — turn on AI_ENABLED on the server.
  - What the model may do: a three-row read-only ladder with "Now" on the current mode, and "Let the model file on its own" (owner) with "Takes effect when every requirement is met."
  - Requirements: one row per server row (including `holding` and `floor`), Met / Not met, "18 of 30 judged" / "16 of 18 right", and the "Judged = …" line.
  - Recent decisions: the server's rows with date, amount, category, source, band and resolution words; Undo (when `undoable`) and Change (the existing CategoryPickerSheet → `PATCH /transactions/:id`); links to Review (N) and Rules.
  - PUT sends only the key that changed. After a PUT, an undo or a change: the settings view is set or refetched, the review queue, rules and agent trail are refreshed, and the global write rule refreshes the spine, ledger and reports.
- **Household**: the dead switch and its words are gone (Household no longer reads UI preferences). The Filing section is one row, "Automation — filing, rules, what the model may do →". The existing "Other tools" section stays as is (V4's "Classic tools" row was not on this base; no change made to avoid a conflict).
- **What's new**: step 2 explains filing in three sentences and links "Open Automation". It writes nothing but "seen" (no `autoCategorize`).
- **Activity**: Review and Rules each carry "How filing works and what the model may do → Automation". Rules gains "Rules you wrote" from `GET /mapping-rules`.
- **Sample**: public `/design/automation` (suggest mode, 18 of 30 judged, "Sample — every figure on this page is made up."), and a "Sample pages" list on `/design`.

## Classic links, before and after

| Where | Before | After |
|---|---|---|
| Today attention "See bills" | `/classic/bills/all` | `/plan/bills` |
| Today "Open bills" (Coming up) | `/classic/bills/all` | `/plan/bills` (in-app link) |
| Rules "Hand-written rules" | `/classic/mapping-rules` | removed: "Rules you wrote" lists them here, with category change and delete (the API has `PATCH` and `DELETE /mapping-rules/:id`, so the classic link is not kept) |
| Household "Other tools" | `/classic/settings` | kept: workbook import, duplicate clean-up and link clean-up have no new-app screen |
| NotFound | classic link | untouched |

## Decisions and departures

- **Bundle.** The open path was 399.9 of 400 KB; a new lazy route costs about 250 B in the entry, and every generated hook a lazy screen imports stays in the entry chunk (about 2 KB for these five). So:
  - `src/data/automationApi.ts` calls the same routes through the same `customFetch` with the same query keys (settings GET/PUT, mapping-rule list/PATCH/DELETE). A test holds its keys and URLs equal to the generated ones.
  - `/household/automation` shares the AI-cost route importer through `screens/household/HouseholdMore.tsx` (AI cost stays one hop; Automation loads inside it).
  - `/design/automation` shares the design-activity importer (`DesignActivity` loads the sample on demand).
  - `App.tsx` builds its five public sample wrappers with one helper. Headroom after all this is under 1 KB; the next lazy route will need the same treatment or a bigger cap.
- The error code `owner_only` is never shown; a refused PUT reads "Only the household owner can do this."
- `heuristic` and `refund` sources read "Pattern" and "Refund"; `locked` reads "You".

## Tests

| File | Covers |
|---|---|
| `household/automation.test.tsx` (new, 15) | all sections from a fixture; AI words; `holding`/`floor` rows; owner PUT payloads (one key each); member disabled with "Owner only"; refused PUT; recent rows words; Undo; Change → PATCH `{categoryId}`; empty and failed states; word maps; hand-written client keys equal the generated ones; sample page; sample via design-activity; `/household/automation` via the shared importer |
| `household.test.tsx` | no switch on Household; one Automation row |
| `today.test.tsx` | What's new step 2 has no switch, links to Automation, and "Done" saves only `whatsNewSeen`; bills link `/plan/bills` |
| `activity.test.tsx` | Rules links to Automation and lists "Rules you wrote" |
| `routes.test.tsx` | new rows and lockstep with `routePrefetch` |

## Gates

| Gate | Result |
|---|---|
| `pnpm run typecheck` | green |
| h2 suite, UTC | 31 files passed, 1 skipped · 504 passed, 4 skipped |
| h2 suite, `TZ=America/Chicago` | 32 files passed · 506 passed, 2 skipped |
| classic suite | 140 files passed, 1 skipped · 1248 passed, 4 skipped |
| `pnpm run build` + entry graphs | green · h2 400.0 / 400 KB (399,9xx raw) · classic 576.1 / 580 KB |
| `pnpm audit --prod` | 1 high (1 ignored by repo config); no dependency change |

## Figures that move

None. No amount, total or balance is read or written differently; the screen only shows the server's view and sends the two switches the API already accepts.
