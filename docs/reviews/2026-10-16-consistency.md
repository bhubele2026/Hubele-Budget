# Consistency pass on the live d8da19c — handoff (2026-10-16)

Branch `consistency/integration` (worktree `/private/tmp/claude-501/cons-int`), from origin/main d8da19c4 (LIVE).
Builder notes: `2026-10-16-c-a-balance.md` (C1–C3), `2026-10-16-c-b-hooks.md` (C4, C5, C7), `2026-10-16-c-c-layout.md` (C6).
**Status: built locally and verified on synthetic fixtures. NOT pushed. NOT deployed.** Deploy only on the owner's word.

## What was fixed
1. **One checking balance, one presentation.** Dashboard tile, Banking cell, Forecast figures and card, and the Forecast
   Overview stat all show "Checking today", the figure, one calculated line ("Calculated · bank read $0.00 Oct 15, 7:02 AM
   · +2 rows since") and one **Details** action (the existing "Why this number?" evidence). "H2 balance", "Bank today" and
   the bare "as of" lines are gone. A typed balance says "Typed balance … (not from the bank)". A missing figure is "—"; a
   real $0.00 prints "$0.00". Contract: `docs/contracts/checking-balance.md` (term table + the calculated-line rule).
2. **Chart start says what it means.** The caption reads "Oct 16 · opens $0.00 · closes $2,614.20" and "Bank read $0.00
   Oct 15, 7:02 AM · +2 rows since" with Details, drawn once in the panel head. The hero line is "Opening · <date>". The
   cash signal carries an additive `opening` block (date, balance, reading, rows since) read from the same ledger.
3. **Overview and detail are one forecast.** Both default to 90 days (the detail no longer opens on 30; 30 stays a tab);
   `?horizon=` and `?day=` are URL state on `/forecast`, restored by Back/Forward; Overview figures name the horizon
   and link into the detail with horizon + the low day; the low point uses the same chip words everywhere (rust only
   below zero; "Under the $N buffer" quiet; a real $0 close is never rust). Overview page and tab kept (owner's call).
4. **Monthly Spend rows tie.** A hook row's words are read under the occurrence's own key (never the day shown), name
   their period when moved ("October's Monthly Spend, due Nov 1"), and list every non-zero part so they add to the
   forecast's figure to the cent, naming a part payment, money already paid, a balance cap, and — when the row shows the
   item's stored amount — what the forecast takes instead. A moved occurrence no longer borrows the answer of the
   occurrence that owns its new day (matches the server's `closedAtMovedDate` rule). No finance calculation changed;
   the golden ledger snapshot is unchanged.
5. **Weekly plan ↔ forecast reserve.** No-plan hook rows carry "Set a weekly plan →" (owner) or "The owner sets the
   weekly plan" (member) → `/spending/week?plan=1` opens the existing plan dialog on the same three choices; the prompt
   says in one sentence that the forecast holds the item's amount until a plan is set. Allowances offers the same link.
   After Confirm every reader flips (the cash signal is now marked stale by every write). Nothing is chosen or saved by
   the app. "Plan not set" ≠ "Plan set to $0" kept.
6. **Forecast actions where the reader is.** Hero + figures → chart (8) beside Selected day (4) → register. Phone: day
   panel directly under the chart. Checking today, From Chase, Missed, Moved and Review bucket fold by default with
   count + total, remember their state, and open themselves when a link or highlight targets a row inside. Every
   action is moved, not rewritten. "Review shortfall" lands on the day with the panel in view at 390 and 1280.
7. **plaidAccountTwinsOnSync.** Test-fixture clock defect (rows dated by the UTC day; the household day is Chicago, so
   after 19:00 CT the ATM row was dated tomorrow and rightly excluded). Rows now dated on the household day; a new case
   runs the merge at 20:30 CT; assertions unchanged. Production is correct.

## Root cause of the balance / forecast discrepancies
- One figure (the bank reading rolled forward through counted rows) wore four labels, and only Banking said it was
  calculated. The two rows after the $0 reading are counted once by `classifyCashRows` (held-by-snapshot → 0; a
  pending/posted pair counts once; pending deposits never count). Screens agreeing proves one ledger, not bank truth.
- The chart caption glued three moments together: the opening of the first day (`startingBalance`, before that day's
  rows), the reading's day, and the first plotted point (that day's close). Both figures were right; the words were not.
- Overview was hard-wired to 90 days with its own words; the detail opened on 30 with the shared chip words.
- Register hook rows showed the item's STORED amount while the words described the forecast's figure, and the words were
  read under the displayed day (so a moved occurrence read the next period's reserve and borrowed its answer).
  The owner's Nov 1 row fits three shapes — a stored amount of the lower figure, October's occurrence moved onto Nov 1, or a
  partial answer — and only his live data (not reachable: signed out) says which. All three now read correctly.
- The $450 weekly reserve and the weekly plan are two sources by design (the Weekly Spend item's amount stands in until a
  plan exists); nothing said so, and the Forecast had no way to the plan.

## Verified, and how
Lead gates on the merged tip 511325f9 (fresh test DB, schema pushed first):

| Gate | Result |
|---|---|
| typecheck | pass |
| API vitest, full suite | 293 files passed, 2 skipped · 3,391 tests passed, 0 failed (plaidAccountTwinsOnSync green, incl. the 20:30 CT case) |
| Web vitest, TZ=America/Chicago | 280 files · 2,887 passed, 0 failed, 2 skipped |
| Web vitest, TZ=UTC | 280 files · 2,886 passed, 0 failed, 3 skipped |
| Build + entry graph | landing 622.0 KB raw of the 622.0 KB budget (190.0 KB gz) — met, zero headroom |
| Codegen drift | 0 |
| pnpm audit --prod | 1 high, the known ignored one |
| journeys2 checks 1, 2, 4, 5, 11, 15 · chromium + webkit · 1280 + 390 | 20 pass / 0 fail / 4 skips (check 5 "cannot reach the Blue tile while Platinum loads" — a harness timing skip on the Amex page, untouched here) |
| axe wcag2a/aa · /home /banking /forecast ?day= landing /forecast/overview /review · 390 + 1280 | one serious hit per page, the same pre-existing shell chip (orange review count in the tab ribbon / nav, `bg-brand-orange/20`), untouched by this batch; nothing new |

- Fixture states (git-ignored kit): `FIXTURE_BALANCE=zero-rows-today` (reading $0.00 yesterday 16:19, two posted rows
  today, synthetic amounts) and `FIXTURE_HOOKS=nov-gap` (a monthly hook on the 1st, October moved onto Nov 1, a partial).
- Builder checks: A — 52/52 headless checks in chromium and webkit at 390 and 1280 (tile link keeps horizon; Banking
  words; KPI = card = caption = fixture; Details; Overview → detail keeps day + horizon; Back/Forward; no horizontal
  scroll). B — every hook row's printed total equals the curve for its occurrence in 4 browser/width combinations × owner
  and member; the owner journey link → dialog → dry run → Set plan flips Spending, Forecast, tile and Allowances; the
  twin test green at 10:10 CT, 20:30 CT (pinned), 23:55 and 00:05. C — `?day=` lands with the day panel on screen (phone
  y 254, desktop y 202); journeys2 subset on chromium 10 pass / 0 fail / 2 env skips.
- Lead: before/after shots on one fixture (`scratchpad/preview/shots/c-final/{before,after}`: Dashboard, Banking,
  Forecast, Overview, Spending week at 390 and 1280); journeys2 checks 1, 2, 4, 5, 11, 15 on chromium + webkit; axe
  (wcag2a/aa) on /home, /banking, /forecast, a ?day= landing, /forecast/overview, /review at 390 and 1280.

## Unresolved (owner's calls and leftovers)
- **Register row amount.** The row still shows the item's stored amount (the WP8 open decision); the words now say
  "= $455.80 on the forecast (item amount $380 not used)". Showing the forecast's figure on the row (and walking it in
  the register's running balance) would remove that clause — a figure change on the register, not taken without your
  word. Recommendation: show the forecast's figure; keep "item amount $X" as a quiet note.
- **Overview: keep (as built) or fold** "Biggest bills ahead" into the detail and drop the tab.
- Live trace of your two rows and the Nov 1 row (Step 0) not taken: the site was signed out.
- Hook-row words get long when every part is present. A day with rows before and on the opening day reads "+N rows
  since" (exact, but the opening then includes the earlier rows). The Forecast "Checking today" card is folded and the
  same figure sits in the figures strip. On /review, From Chase starts open whenever the inbox has rows.
- A latent double count the trace found (not changed, no screen can write it today): a partial answer on a hook row
  subtracts its row even when that row already counts elsewhere.
- Landing budget: 622.0 KB of 622.0 — met with zero headroom; the next landing change needs a trim first.
- Pre-existing axe contrast hit on the shell's orange count chip (tab ribbon, nav, mobile nav) — not from this batch.
- Not run: firefox; the e2e specs that need the real stack; full API suite inside the builders (the lead ran it once on
  the merged tip, above). No What's new note added (words, links and layout only) — add one if you want the household told.

## Preview
Fixture kit (git-ignored): `FIXTURE_SEED=rich2 FIXTURE_BALANCE=zero-rows-today bash <scratchpad>/preview/start.sh
/private/tmp/claude-501/cons-int 3420 5220` → http://127.0.0.1:5220 (owner persona). Shots as above.
