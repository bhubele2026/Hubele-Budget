# F6 — Afford launcher + Spending › Wish list (2026-10-09)

Branch `restore/f6-afford-wishlist`, base `a99b4069`. Parity doc "New-app features to fold in", row F6. No server or spec change; every verdict and figure is the server's (`POST /money/afford`, `POST /wishlist/{id}/evaluate`, `GET/POST/PATCH /wishlist`).

## Ported (pure logic, with tests)
- `lib/afford.ts`: `VERDICT` (four words, chip tone), `DECISION`, `monthWord`, `comingSaturday`, `parseDollars`, `parseAmount`, `isWebAddress`, `apiMessage`, `refusal`. `lib/afford.test.ts` (9 tests) carries h2's verdict-word, decision, comingSaturday and parseAmount cases.
- Verdict tone is a `.chip` word (ok / warn / bad), never colour alone.

## UI (h2budget primitives only; nothing imported from h2)
- `components/afford/AffordSheet.tsx` (dialog): amount, When chips (Today / This weekend / Next payday) + date, optional category and member (member only when personal allowance plans exist), Check, result with verdict word first, before to after for Free until payday / This week / category, debt-free range and shift, assumptions, "Add to wish list". Stateless until Add is pressed. 15 tests (`afford.test.tsx`) port h2's.
- `components/afford/AffordLauncher.tsx`: button; the sheet is a lazy chunk loaded on first press.
- Launcher placed on Budget (head row), Allowances (head row) and the dashboard (`/next/dashboard`, top row).
- `pages/wishlist.tsx` at `/wishlist`: Active and Decided panels, Check now, Bought / Dropped (409 inside the waiting period gets its own words), Add dialog (title required, dollars, https link only). 5 tests.
- Route: `App.tsx` lazy route; `lib/routePrefetch.ts` (`importWishlist`, `/wishlist` key); Spending ribbon gains "Wish list" (`layout.tsx` tab + owns); `routes.test.tsx` row + ribbon list; `appShell.test.tsx` ribbon/drawer lists updated.

## Hooks
All new hooks (`useEvaluateAfford`, wishlist hooks, `useGetMoneyPosition`, `useListAllowancePlans`) come from `@workspace/api-client-react/features`; `featuresImportGraph` still passes. Existing main hooks only for categories, me, members.

## Not done / notes
- Sample (public demo) mode and the Ask-triggered `defaults` entry are not built; `defaults` is accepted by the sheet for later.
- The launcher is not on the classic Banking page or the new forecast; the row asked for Budget, Allowances and the dashboard.

## Gates
typecheck clean; vitest UTC 1,494 passed / 4 skipped, America/Chicago 1,496 passed / 2 skipped; build OK, landing JS 563.1 KB of 580 KB (route + ribbon rows only; sheet and page are lazy), no recharts on open; audit 1 high, already ignored.
