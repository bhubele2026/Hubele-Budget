# PR3 close-out — the invalidations behind "Why this number?" are tested, and PR3 is done

Codex work-order point **12**. This closes plan PR3 on top of PR3b5 (merged as `a71243e`). Plan:
`~/.claude/plans/h2-budget-work-serene-pebble.md`.

## The problem

PR3b5's second look approved it and left NITs:
- **Untested invalidations.** Two invalidations keep "Why this number?" from ever explaining an older bank balance
  than the tile shows: one after every Sync, one after every successful write. Deleting either one passed every
  test.
- **An ambiguous heading.** The PR3b5 note's "No new request on open" could mean opening the app or opening the
  popover.

## What changed

- **New `lib/mutationInvalidation.ts` `invalidateAfterWrite(queryClient)`.**
  - It holds the rule `App.tsx`'s `mutationCache` already applied after every successful write. It marks stale:
    - the spine;
    - "Why this number?";
    - every `/api/reports/` aggregate.
  - `App.tsx` now calls it.
  - The three invalidations are the same as before, so behaviour does not change.
- **`hooks/use-plaid-sync.test.tsx`:** a Sync marks the bank-balance explanation stale even when no rows changed.
- **The PR3b5 note:** the heading now reads "No new request when the app opens", and a "Second look" line records
  the approval and the merge.

## Figures that should move

**None.** No behaviour changes.

## Must not change

- **After every successful write,** the same three query families are marked stale, and nothing else.
- **After every Sync,** the explanation is marked stale.
- **The landing page.** No change in what it does. It does gain about 0.1 KB: see Verification.

## Tests

- **New `lib/mutationInvalidation.test.ts`** (4), on a real `QueryClient`:
  - the spine, the explanation and a reports aggregate are marked stale;
  - an unrelated query is left alone.
- **`hooks/use-plaid-sync.test.tsx`** (+1): Sync invalidates `["/api/forecast/bank-balance-explain"]` with no row
  changes.

## Verification

- **Workspace typecheck and build:** pass.
  - The first build failed typecheck. `onSuccess: () => invalidateAfterWrite(queryClient)` made TypeScript infer
    the return type through `queryClient`, which is built from the same `mutationCache`, so the types went circular
    (TS7022).
  - The callback now has a block body, as the original did, with a comment saying why.
- **Full web suite (clock in UTC, as on CI):** **118 files, 917 pass**, five more than PR3b5: the four
  invalidation cases and the Sync case. Re-run on the final code, after the typecheck fix.
- **API suite:** not re-run. No server code changed.
- **Landing bundle guard:** **572.5 KB of 580**, up **0.1 KB** from PR3b5.
  - The extracted helper costs about 100 bytes: its function wrapper and its imports, in the entry chunk.
  - It buys a test that pins every key the rule must mark stale.
  - PR3 as a whole is now **+1.2 KB** (571.3 → 572.5), 0.2 KB over the plan's 1 KB allowance. The enforced 580 KB
    cap is met.
  - The real fix for this kind of growth is still Orval `tags-split` (Left for later).
- **End-to-end:** unchanged specs. Playwright is opt-in on CI and was not run locally.

## PR3, as shipped

Every part had an independent review before it merged. Each is live on Render (`/api/version` matched, and
`/api/healthz` returned 200).

| Part | What it did | Main |
|---|---|---|
| PR3a | The server decides when the bank balance is stale, with truthful attempt rows | `183328e` |
| PR3b1 | Data states, a null review count, the freshness line and refresh banner | `5805efb` |
| PR3b2 | "—" for money that hasn't arrived, and the sign-in spine recovery | `b6c32f7` |
| PR3b3 | The Forecast bank line takes the server's verdict; Bills overview invents no month | `5ca3843` |
| PR3b4 | Reports tiles and Chase stats wait for their figures | `b4cf585` |
| PR3b5 | "Why this number?" on the Banking bank balance | `a71243e` |

- **Landing bundle over PR3:** 571.3 → 572.5 KB, which is **+1.2 KB** including this close-out, 0.2 KB over the
  plan's 1 KB allowance. The enforced 580 KB cap is met.
- **Why it grew:** the generated API client sits whole in the landing chunk, so each new endpoint hook keeps its
  helpers there. See the PR3b5 note.

## Left for later

- **PR4, cash today, one rule.** Split into PR4a-PR4d, possibly with a PR4e:
  - extract the ledger;
  - `isInSnapshot`;
  - pending superseded;
  - the Plaid sync fixes;
  - optionally, the web roll-forward.
- **Bundle:** try Orval `tags-split`, so helpers used only by lazy pages leave the landing chunk.
- **Server:** reason codes for `nextSync.whyNot`; read the settings row once in `/spine`.
