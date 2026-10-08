# S4 — Household and Recap

Branch `reinvent/s4-household-recap` off `origin/main` `ce9a23b8` (S0, S1, S3, PR-B1, PR-A, PR-D, AI-3, AI-4a, AI-4b, AI-1 merged). Frontend only: **no API, schema or generated-client change**; every call is an existing generated hook.

## What changed

| Area | Files | What |
|---|---|---|
| `/household` Banks | `screens/household/Household.tsx`, `BankLink.tsx`, `words.ts`, `parts.tsx` | Each linked bank: name, accounts (name · ending mask · type), "Synced 12 minutes ago", one status word (Working / Needs reconnect / Preparing / Feed stopped). Sync (free), Reconnect, Remove, Connect a bank, the "make these debts?" sheet, the post-link progress with the classic backoff poll (3, 4, 6, 8, 10, 12, 15, 15, 18 s) |
| `/household/members` | `Members.tsx` | Owner: members with role, remove (Sheet), invitations with status words, invite, resend, cancel. Member: read-only note |
| `/recap` | `screens/recap/Recap.tsx`, `recapWords.ts` | Phone (consent sentence above the checkbox, send code, 6-digit confirm, masked "•••• 0100" with Change), Schedule (time, five zones + Other, skip weekends, extra alerts, Enabled), Preview (template + model draft, "Demo" label, AI note, test text with the count left, pause, unsubscribe), History |
| Account menu | `shell/AccountMenu.tsx`, `shell/Shell.tsx` | The avatar opens Household, Recap, Account (Clerk profile) and Sign out (Clerk `signOut`). Masthead and Dock are **untouched** (Shell passes the menu in through the existing `account` slot) |
| Routes | `App.tsx`, `lib/routePrefetch.ts`, `routes.test.tsx` | Four lazy routes in lockstep: `/household`, `/household/members`, `/recap`, public `/design/recap` |
| Retiring classic links | `today/attention.ts`, `Today.tsx`, `WhatsNew.tsx`, `kit/ActionCard.tsx`, `plan/PlanDebt.tsx` | Reconnect and Sync on Today now go to `/household`; What's new step 3 opens `/recap`; the classic row says only "Workbook import still lives in the classic app."; the Plan debts foot points at Household. `ActionCard` uses a router `Link` for a path inside H2 (a full page load only for `/classic/…`) |
| Sample | `screens/design/DesignRecap.tsx` | `/design/recap?page=recap|banks|members` (`&state=new|history-failed|empty`), public, synthetic, labelled "sample" |

## Data sources (all existing generated hooks)

| What | Hook | Notes |
|---|---|---|
| Banks | `useListPlaidItems` | refetches every 90 s only while a bank is `stillPreparing` |
| Link | `useCreatePlaidLinkToken`, `useCreatePlaidUpdateLinkToken`, `useExchangePlaidPublicToken`, `listPlaidLiabilityAccounts({refresh:true})`, `useBulkCreateDebtsFromPlaidAccounts` | same order and bodies as classic; a 409 `relink` falls back to a fresh link |
| Sync / remove | `useSyncPlaidTransactions` (`{itemId}` or `{itemId, force:true}`), `useDeletePlaidItem`, `useClearPlaidItemRefreshDisabled` | |
| Plaid setup | `useGetPlaidEnvironment` | disables Connect and says why when not configured |
| Members | `useGetMe`, `useListMembers`, `useListInvitations`, `useCreateInvitation`, `useResendInvitation`, `useRevokeInvitation`, `useRemoveMember` | list calls only for the owner |
| Recap | `useGetRecapSettings`, `useUpdateRecapSettings`, `useStartRecapVerification`, `useConfirmRecapVerification`, `useSendRecapTest`, `usePauseRecap`, `useUnsubscribeRecap`, `usePreviewRecap`, `useListRecapHistory`, `useListRecapDeliveries`, `useHealthCheck` | recap writes carry `OWN_INVALIDATION` (they move no figure) |
| Filing switch | `useGetUiPreferences` / `useUpdateUiPreferences` | merges `autoCategorize` into the stored object |

Generated names differ from the brief's guesses (`useListMembers`, `useRemoveMember`, `useRevokeInvitation`, `useExchangePlaidPublicToken`, `useListRecapHistory`, `useHealthCheck`); each was read from `generated/api.ts`.

## Figures that move

**None.** The package shows no money figure (the debts sheet lists names and masks, never a balance). The only counts are Sync's new rows (the server's `added`) and "N left today", which is 3 less the test rows in the last 24 hours of `GET /recap/deliveries`.

## Laws kept

- **Billing:** a plain Sync sends `{itemId}` and never a `force` key. The billable pull is behind a Disclosure ("A pending charge is missing?") holding the sentence "This asks the bank for a fresh pull and may cost a small fee." and then a Sheet confirm; "Turn fast refresh back on" asks the same way. The one billable call the flow makes unasked is the first pull after a link or a reconnect (`force: true`), exactly as classic.
- **History stays:** Remove's sheet says so. A bank that only needs a sign-in is offered Reconnect first (classic's disconnect guard).
- **Reconnect before a second link:** Connect asks first when a bank needs reconnecting (classic's fresh-link guard); seed rows (`seed-…`) are never asked to reconnect.
- **A "ready" panel never overrides a reconnect:** if the linked item still carries a re-auth code the panel says it still needs reconnecting.
- **Consent before the code:** Send code needs the checkbox and a valid US number; nothing is sent otherwise. The consent sentence is the server's `consentText`, shown above the box.
- **The server decides:** the 400 (`not_verified`, `no_consent`, `opted_out`) and 429 (`test_limit`, `too_many_starts`, `locked`) answers are shown in the server's own words.
- **No real numbers:** tests and the sample page use +1 555 01xx.

## Tests and fails-before

- `screens/household/household.test.tsx` (29): bank rows in words; reconnect only where needed; skeleton, empty, failed, refresh-failed; unconfigured server; the classic link; Sync body has no `force` and shows Syncing… then "3 new"; nothing-new and failure words; Force refresh sentence in a closed disclosure, the sheet, "Not now" sends nothing, only the confirm sends `force: true`; re-enable asks first; Remove sheet and confirm, reconnect-first, failure; the whole link flow (token, storage keys for `/plaid-oauth`, exchange body, `refresh: true`, the debts sheet scoped to the new bank with no amounts, the bulk body, the force poll, "Ready. 2 added."); polling until "still preparing"; a hard error stops the poll; closing Plaid exchanges nothing; the guard; reconnect through update mode (no exchange), the 409 relink fallback, the `plaid:reconnect` event; the filing switch merges into existing preferences; Members owner vs member (rows, no Remove for the owner or you, status words, invite validation and body, resend, cancel, server error words, remove sheet) and the member's read-only view.
- `screens/household/words.test.ts` (12) and `screens/recap/recap.test.tsx` (31): no money figure; skeleton and error; the preview-mode line; consent above the checkbox and required; E.164 and `consent: true`; the server's refusal; the 6-digit rule (five refused without a call); masked number and Change; opt-out note; Enabled gated, `{enabled:true}`, the 400 message; schedule save body; the five zones and Other; preview with and without Demo, the AI note only when AI is off; test text count and the 429 message; pause and resume; unsubscribe behind a sheet; history words (delivered / sent / failed with why / skipped, source words, text in a closed Disclosure).
- `shell/accountMenu.test.tsx` (5): closed until pressed, initial, items and hrefs, focus to the first item, arrows/Home/End, Escape returns focus, Sign out calls Clerk, click outside, navigation closes.
- `routes.test.tsx`: four new rows and importers; the lockstep checks cover them. `today.test.tsx`: the three classic hrefs became `/household`, `/recap`, `/household`, and the classic row's sentence.
- **Fails-before:** the new files do not exist on `ce9a23b8`; `routes.test.tsx` fails there with the four rows added; the three `today.test.tsx` href assertions fail against the old `/classic/settings` links.

## Gates

| Gate | Result |
|---|---|
| `pnpm run typecheck` | clean |
| H2 tests, TZ=UTC | 24 files, 342 passed, 3 skipped |
| H2 tests, TZ=America/Chicago | 24 files, 343 passed, 2 skipped |
| Classic tests | 140 files passed, 1 skipped; 1,248 passed, 4 skipped |
| API suite (`h2budget_test_s4`, CI=true, `db push`) | 203 files; 2,165 passed, 13 todo (no API file changed) |
| `pnpm run build` | both apps built |
| Entry graph, H2 | 387.1 KB raw (114.2 KB gz) of 400 KB; Household 16.6 KB, Recap 15.9 KB, Members 6.9 KB, DesignRecap 4.3 KB, all lazy |
| Entry graph, classic | 576.1 KB of 580 KB |
| Plaid Link lazy | `react-plaid-link` (the `link-initialize` string) is only in the `PlaidOAuth` chunk, which Household imports for the two storage-key constants; neither is in the entry graph |
| `pnpm audit --prod` | 1 high, ignored by the repo config; none from this package |

## Screenshots (scratchpad `s4-out/`: `s4-recap-390|1280`, `s4-recap-new-390|1280`, `s4-banks-*`, `s4-members-*`, `s4-sheet-390`; `/design/recap`)

- 390 and 1280, no horizontal scroll on any page (scrollWidth equals the viewport), no console errors.
- Banks: a "Household" headline over a two-part Banks/Members bar; the clay "needs reconnecting" note with one Reconnect button; four banks in a hairline list, each with name and a status word on the right, "Synced …", plain account lines, Sync and Remove, and a closed "A pending charge is missing?" disclosure; the Filing switch; one sentence naming the classic app.
- Recap (verified): headline and one sentence, the quiet "preview mode" line, "Verified •••• 0100" with Change, the time field, zone select and two switches, Preview and "Send a test text · 2 left today", pause, a clay Unsubscribe, and the history (Delivered, Failed with its reason, Skipped; each text in a Disclosure). New number: the phone field, the consent sentence above the checkbox, Send code.
- Remove sheet at 390 rises from the bottom over the page.

## How to enable the morning text

1. Open the avatar menu (top right), choose **Recap**.
2. **1. Your phone:** type your US mobile number, read the consent sentence, tick "I agree to get these texts", press **Send code**.
3. Type the 6-digit code from the text and press **Confirm**. The number now shows as "•••• 1234".
4. **2. Schedule:** pick the time and zone (default 7:00 AM Central), choose skip weekends and extra alerts, press **Save schedule**.
5. Press **Preview today's recap** to read the text; press **Send a test text** to receive one (three a day).
6. Turn **Morning recap** on. It stays off until steps 2 and 3 are done.
7. To stop: **Pause until** a date, or **Unsubscribe**; replying STOP to any text also opts out.

Texts only leave the server when Twilio is configured (AI-4b's owner checklist); until then the page says "Texts are in preview mode until SMS is configured." and the code appears on the page in preview mode.

## What still links to classic

- Workbook import, "Dedupe duplicate transactions" and "Remove non-production links": one link, `/classic/settings`, in Household's "Other tools" (the brief's "classic" word is in the sentence).
- Today's "Classic app" row: "Workbook import still lives in the classic app."
- Not ported anywhere (each is a classic-only control that nothing here replaces): the per-account first-sync cutoff date, the "disconnect date checked" refresh, and the `modelAutoCategorize` gate. Today's "Open review" and "See bills" still go to `/classic/review` and `/classic/bills/all` until S2 and a bills package land.

## For the lead to reconcile with S2

- **Shared files, additive only:** `App.tsx` (importers, four lazy consts, three routes, `PublicDesignRecap`, `/design/recap`), `lib/routePrefetch.ts` (four importers and keys), `routes.test.tsx` (mock importers, four rows, the key list, the minimum-declared count 12 to 16, a `useUser` in the Clerk mock), `shell/Shell.tsx` (one line: the account slot), `kit/ActionCard.tsx` (router `Link` for in-app paths).
- **Not touched:** `kit/destinations.ts`, `kit/nav.test.tsx`, `kit/Masthead.tsx`, `kit/Dock.tsx`, anything under `screens/activity/`.
- S2's `/activity` row and importer will sit beside mine in the same four places; the key list in `routes.test.tsx` is sorted, so both additions are one line each.

## Residuals

- **Members cannot see the member list.** `GET /members` is owner-only, so a member's view is "you" and who manages the household, not "who else is here". Showing others needs a read route for members (an API change, outside this package).
- **The reconnect banner and the "plaid:reconnect" listener live on `/household`, not in the shell.** A shell-level banner would add a `/plaid/items` fetch to every open (and Plaid Link to the entry graph, which sits at 387 of 400 KB). Today's attention card and its stale-bank note both link to `/household`, where the banner opens the reconnect. The event is still honoured while Household is open.
- **"The agent's handled list" has no endpoint of its own.** The only agent setting the API exposes to this screen is the `autoCategorize` preference (AI-1), so Household has a "Filing" switch for it. The stricter `modelAutoCategorize` gate is not surfaced.
- **Account item added.** The menu has an "Account" item (Clerk's profile panel) beside the three the brief names, because replacing Clerk's `UserButton` otherwise removes the only way to change a password.
- The first pull after a link or reconnect is billable (`force: true`), as in classic; it is the only one the flow sends unasked.
- A test text's "N left today" is counted from the delivery log (the response carries no count); it is a hint, and the server's 429 is the authority.
- The pause sends the start of the picked day in the browser's time zone.
- Plaid Link itself (the iframe) was not driven in a browser: its callbacks are exercised through the mocked hook. The real hand-off needs one pass on the deployed app with a sandbox bank.

## Questions for the owner

- Should members see the list of who else is in the household? It needs a small read route.
- Should a bank that needs reconnecting also raise a banner on every screen, at the cost of one extra request on open?
