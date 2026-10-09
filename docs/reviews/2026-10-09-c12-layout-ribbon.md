# C12 — Header, ribbon, drawer and More on the tokens; fold-in sub-items (2026-10-09)

Branch `restore/c12-layout-ribbon`, cut from `origin/main` a87c0409 (F8 merged), then merged with 8d53083c (C13, F4).
Spec: `2026-10-08-parity-verified.md` §3 (SH-01…17) and §8 C12.
No API, spec, query or money change. `App.tsx` and `routePrefetch.ts` are untouched: no route was added or moved, so C13's route lines merged cleanly.

## What changed

- **Tokens.** The chrome now has its own token set in `index.css` (`@theme`, "CHROME"):
  - ink: `chrome-ink`, `-ink-hover`, `-ink-2`, `-ink-3`, `-ink-4`;
  - grounds: `chrome-hover`, `chrome-press`;
  - one hairline: `chrome-rule`;
  - `inset-shadow-chrome-edge` (the rule under the header) and `shadow-tab-glow` (the underline glow, mixed from `--color-brand-orange`).
  - Every `white/NN` utility (22 by now, not 15), both `rgba()` glows and the inset `rgb()` rule in `layout.tsx` and `tab-ribbon.tsx` are gone.
  - The three rule strengths (10, 12, 15 %) became one (12 %), and the two faint inks (40, 50 %) became one (45 %). Nothing else moved: the harness reads the same computed colours as before (lit tab white, resting 60 %, the 12 % inset rule, the 55 % orange glow).
- **One underline.** `TabUnderline` (in `tab-ribbon.tsx`) is drawn by both the ribbon and the More trigger, so the two cannot drift.
- **Home › Accounts.** `/next/accounts` is a Home tab BESIDE Chase and Amex: Overview · Chase · Amex · Accounts · Budget · Allowance. Home owns `/next/accounts` (and `/next/accounts/:id`), so the preview shows Home's ribbon with Accounts lit. Chase and Amex are unchanged.
- **Review › Suggestions.** Review · Categories · Suggestions · Chase · Amex. The tab carries no count: an open-proposal count would put the `features` client on the open path.
- **Spending › Wish list.** Already there (F6); unchanged.
- **Settings sub-pages.** Household, Data, Automation, Morning text, AI cost, Memory and Privacy are listed beneath Settings:
  - in the phone drawer, as a destination's pages sit beneath it; the open sub-page is the lit row and Settings reads as "you are inside";
  - in the desktop More menu, indented under Settings; the page you are on is marked (`aria-current`).
  - Banks is the Settings row itself (plain `/settings`), so it is not listed twice.
  - The list comes from the page's own tab list. That list moved into `pages/settings/settingsTabList.ts` (re-exported by `settingsTabs.ts`), so the shell reads it without pulling the tabs' lazy importers onto the open path.
- **Drawer.** It is now taller than a phone, so it opens with the lit row scrolled into view.
- **Dead More dot.** `moreBadgeTotal` and its orange dot are deleted. Nothing in More ever had a count.
- **Version (LND-09).** `components/account-menu.tsx` wraps Clerk's `UserButton` with one item of ours, "Version <build>", after Manage account and Sign out. Tapping it copies the build id. The same menu opens from the header and the drawer, and the drawer's Account row also shows the version under "Account". The dashboard's own version line stays.
- **Ask launcher.** Kept as F8 built it, now on the tokens.

## SH-01…17

| ID | Kept | Test or test id |
|---|---|---|
| SH-01 | kept: the top line is unchanged and stays until the switch | `appShell.test` "(SH-01) the top line stays on every page…" (new; was untested) |
| SH-02 | kept: navy horizontal header on every page, `/home` included (C11); now on tokens | `app-header`; "(C11) keeps the header on the landing" |
| SH-03 | kept: wordmark → `/home` | `brand-home`; "puts the wordmark in the header, pointing home" |
| SH-04 | kept: tabs, count badge, underline, hover/focus warm, chevrons, ←/→, boundary-aware lit tab | area-model and boundary suites; "(SH-04) ←/→ on the ribbon…" (new); `ribbon-scroll-left/right` unchanged (jsdom has no layout; the harness shows none needed at 1280) |
| SH-05 | kept: More outside an area, with Settings' sub-pages; dead dot deleted | `topnav-more`, `morenav-*`; "More lists Settings' sub-pages…", "More marks the page you are on…", "More has no dot…" |
| SH-06 | kept: drawer with areas, nested pages, More (with Settings' sub-pages), Account; closes on navigate; phone page title | the drawer suites; "the drawer lights the open Settings sub-page…"; `mobile-page-title` |
| SH-07 | kept: Review badge, phone-only where the ribbon shows Review; F1's forecast + queue | "the review count is a finding…" and "(F1)…" suites |
| SH-08 | kept: account menu in header and drawer, now with the version item | `user-button`; "the account menu carries the build version…", "tapping the version copies the build id" |
| SH-09 | kept: the seven hover query branches and the idle chunk warm, code unchanged; a Settings sub-page warms `/settings` | "prefetch machinery survives the rewrite"; "…hovering one warms Settings" |
| SH-10 | kept: `<main>` is the only scroller, `.page-in`, `max-w-[1600px]` + `.shell-pad` | "renders the page keyed on location…"; `shellScrollContract.test.ts`; `a11y-smoke`/`perf-open` still find `<main>` |
| SH-11 | kept: `VersionUpdatePrompt` untouched | not unit-tested (as before) |
| SH-12 | kept: untouched | `mutationInvalidation.test.ts` |
| SH-13 | kept: `App.tsx` untouched | `routes.test.tsx` |
| SH-14 | kept: untouched | `spineRecovery` tests |
| SH-15 | kept: untouched | — (as before) |
| SH-16 | kept: untouched | — (as before) |
| SH-17 | kept: redirects untouched | `routes.test.tsx` rows `/`, `/dashboard`, `/recurring` |

## Tests changed with a reason

- `appShell.test.tsx`:
  - Home and Review tab orders gained Accounts and Suggestions;
  - the hand-typed ribbon-route list gained `/next/accounts` and `/review/suggestions`;
  - the drawer tree gained Accounts under Home and Suggestions under Review;
  - the More group now ends with Settings' seven sub-pages;
  - the Clerk stand-in renders `UserButton`'s compound parts so the version item can be asserted.
  - New: the C12 block (11 tests), including a source guard that `layout.tsx`, `tab-ribbon.tsx` and `account-menu.tsx` hold no `white/NN`, `rgb()`/`rgba()` or hex literal. Mutation-checked: putting one `text-white/50` back fails it.
- `routes.test.tsx`: the hand-typed ribbon table gained the two tabs. The `/next/accounts` rows now land in Home (they were "no area"). The Clerk mock gained `UserButton.MenuItems`/`Action`.

## Bundle

- Landing: **621,007 bytes (621.0 KB) of the 622 KB cap.** Main 8d53083c measures 618,723, so this block adds 2,284 bytes: the version item and its icon, the Settings list, and the new menu and drawer markup.
- The first build was 621.2 KB. Splitting the Settings tab list off its lazy importers (Rollup keeps a module whole) took 0.6 KB back.
- Cap not touched. Headroom is now about 1 KB.
  - Next lever if a later block needs room: make the drawer's contents a lazy chunk. It is phone-only and opened on a tap.
  - Its tests open it and read it at once, so they would have to become async. Not done here.
- No recharts on open; audit 1 high, already ignored.

## Harness (headless, the real `AppLayout`, Clerk stubbed, page bodies stubbed)

- Shots at 1280 and 390: Home with Accounts, Accounts lit, Review with Suggestions lit, Settings › Memory, More open, the account menu, and the drawer open on Settings › Memory, Home and Suggestions.
- Checked:
  - no sideways overflow in the header or the page;
  - no ribbon chevron at 1280;
  - the lit tab's computed colour is white, the rest 60 %, the inset rule 12 %, the glow brand orange at 55 %;
  - the drawer lights exactly one row, scrolled into view;
  - the version reads in the drawer and the menu;
  - no console errors.

## Gates

- `pnpm run typecheck`: clean.
- h2budget vitest (after the C13/F4 merge): UTC 1,763 passed / 3 skipped; America/Chicago 1,764 passed / 2 skipped (200 files).
- `pnpm run build`: OK.
- `node scripts/check-entry-graph.mjs`: 621.0 of 622 KB.
- `pnpm audit --prod`: 1 high, ignored.
- No API, spec or codegen change.

## Left for others

- SH-01, the top line, goes at the switch (its own block).
- A count on Review › Suggestions needs a way to read open proposals off the open path.
- The wordmark keeps its own inline colours (navy, orange, white, the 82 % ring). Its test pins the computed colours, and it is not part of the chrome restyle.
