# C3 — Allowances on the panel kit (2026-10-09)

Branch `restore/c3-allowances`, base `5998080b`. Parity doc §2.12 and §8 C3. Composition and dialog tokens only: no query, handler, setting or money change. D10/D11 (money questions) and the 500-row window finding are untouched.

## What changed
- Page body is a `PageGrid` (staggered). Head row with the streak chip is span-12.
- The three bucket cards are `.panel` span-4 with `panel-head` (state chip and Help stay in the head); the date cycler, expand button, planned popover, meter and variance line are unchanged.
- 8-week money-left bars: span-6. Transaction breakdown collapsibles: span-6. Over/under summary table: span-12.
- `SplitTransactionDialog` moved off shadcn `Button`/`Input` and `text-muted-foreground`/`text-destructive` onto `ui.tsx` tokens (`input`, `btnSm`, `btnSecondarySm`, `btnLink`, `text-bad`, mono total line). Same fields, validity rule, write order and test ids. The shadcn `Dialog` shell and `Select` are kept.
- No per-person cards (PlanWeek fold-in, not this page).

## Capability ids (all kept)
- AL-01..15, 17: kept by `allowancesKitRestyle.test.tsx` (18 existing tests pass unchanged: chip classes, rgb fills on `.bar-sweep`, marker, oldest-first order) plus a new placement test (spans 4/6/12).
- AL-16 split purchase: kept, and now has its first test, `split-transaction-dialog.test.tsx` (two starting parts, valid only when the parts add up, add/remove part, parts 2..N created before the original is PATCHed to weekly with the monthly/unplanned flags cleared). The page test still mocks the dialog.
- AL-18/19 do not exist on this page; unchanged.
- No e2e exists for this page.

## Gates
typecheck clean; vitest UTC 1,418 passed / 4 skipped, America/Chicago 1,420 passed / 2 skipped; build OK, landing JS 562.5 KB of 580 KB, no recharts on open; audit 1 high, already ignored.
