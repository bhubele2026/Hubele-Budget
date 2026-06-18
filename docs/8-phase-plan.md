# H2 Budget — 8-Phase Plan to "Perfect"

**Source of truth:** this repo (GitHub). Replit is hosting/deploy only.
**Mission anchor:** the 50-point manifesto — get to **$0 debt as fast as the
math allows**, and make the plan so easy to stay on that you don't quit. Every
phase ties back to those points (referenced as `M#`).

## Hard rules (every phase)

1. Read the listed files first; confirm current behavior before coding;
   propose a diff plan, then implement.
2. `pnpm run typecheck` and the relevant `vitest`/`playwright` suites must pass
   before a phase is "done." **No phase may delete or weaken a test to go
   green** — fix the code, not the test.
3. Money is `numeric(12,2)` exchanged as **strings**; `transactions.amount`
   sign is **positive = income, negative = expense**; every table is
   household-scoped and `requireAuth` is mandatory. Never violate these.
4. Each phase lands on its own branch → PR → merges only when CI is green.
   Nothing unverified reaches the deploy branch.

> Verification note: the working machine has no Node/pnpm toolchain, so the
> CI pipeline built in Phase 1 is the verifier. Loop: implement → push → read
> GitHub Actions → fix red → merge on green.

---

## Phase 1 — Foundation & guardrails
Make the repo impossible to silently break.
- CI pipeline (`.github/workflows/ci.yml`): typecheck + api vitest + web vitest
  + Playwright (headless), pnpm cache, fail on any failure.
- Centralized fail-fast env (`api-server/src/lib/env.ts`): one Zod schema parses
  `process.env` at boot and throws listing every missing/invalid var. A typo'd
  var fails at **boot**, not first request.
- Global Express error handler in `app.ts` (Express 5 forwards async rejections
  natively) — pino-logged, sanitized JSON, no hung requests.
- Error monitoring (Sentry) on server + web behind an env flag; confirm the
  page error boundary wraps every route.

## Phase 2 — One payoff engine, proven correct (M1–M4, M9, M11, M46–M50)
Kill the duplicated avalanche simulator (`h2budget/src/lib/avalanche.ts` vs
`api-server/src/lib/avalancheSim.ts`, hand-synced today).
- Extract one isomorphic `simulate()` into `lib/avalanche-core/` (zero UI/DB
  deps); server + client both import it; delete the copies.
- Golden-master tests snapshot current output across portfolios before deleting.
- Property tests: total paid ≥ principal; payoff month monotonic as extra ↑;
  freed minimum redirects fully to next target next month; no off-by-one on
  payoff date.

## Phase 3 — Cash forecast & "true spare" accuracy (M12–M14, M17, M25, M46–M47)
Make the 90-day forecast trustworthy enough to overpay from surplus.
- Regression-test the math: 90-day projection mirrors checking; forecast bends
  around payoff dates + surfaces freed cash; weekly-cap leftover = avalanche
  fuel; bills event-based (full amount in due week).
- Decompose `forecast.tsx` (4,600+ lines) into `pages/forecast/` children;
  target no file > ~800 lines; existing tests stay green.
- Audit the balance-mismatch breakdown.

## Phase 4 — Data trust: Plaid + reconciliation (M20, M29–M34)
Hardening, not rebuilding (most battle-tested area).
- Idempotency sweep across every sync path (initial/cursor/gap/forced).
- Transfer/card-payment masking can't fake slack; respect user-override.
- Reconcile-to-zero decrements the right bill; confetti only at exactly zero.
- Self-healing startup jobs proven not to nuke healthy links.

## Phase 5 — Close the manifesto gaps
- Build `docs/manifesto-coverage.md`: one row per M1–M50 (implemented? tested?
  file?). Fill every partial point with code + test; flip rows green.
- Likely fill-ins: M18 (two-weeks-over trash talk), M19 (reimbursables settle),
  M37/M38 (days-since + streak chips), M28 (debrief shows only open items),
  M9 (Kill Order = next 3 ranked moves).

## Phase 6 — UX, accessibility & performance (M5, M31, M35–M36, M43)
- a11y pass (names, table headers, focus traps); add axe to Playwright.
- Decompose the biggest pages (`reports.tsx` 3,351, `transactions.tsx` 2,908,
  `mapping-rules.tsx` 2,682); memoize heavy lists; consistent skeletons.
- Motivation polish: streaks, days-since, Amex-at-a-glance, reconcile confetti.

## Phase 7 — Mobile parity (M42–M45)
Close the ~7-screen Expo app vs ~24-page web gap. `h2budget-mobile` is a
STANDALONE Expo project — keep it OUT of the pnpm workspace (React 18 vs web's
React 19). Home glance, quick-categorize (reuse API), streaks + skeletons,
one-step unlock (Clerk), web↔phone sync correctness.

## Phase 8 — AI advisor safety + release DoD (M39–M41)
- Every destructive advisor tool writes a proposal + audit-log row and is
  undoable; assert no write path bypasses the audit log; household-scoped.
- Advisor can never move money without explicit user confirmation.
- Pre-import snapshot + one-click restore for the destructive workbook import.
- `helmet` + rate limiter; confirm CORS `origin: true` is intentional.
- Final: full typecheck + every suite green in CI; manifesto matrix 100% green.

---

## Throughline (M46–M50)
Income in → bills + caps reserve what's needed → everything left is avalanche
ammo → the debrief tells you how much you freed → the avalanche fires it at the
highest-APR debt → each kill feeds the next → repeat to **$0**. Phases 2–5 make
that machine *correct*; 1, 6–8 make it *safe, fast, and everywhere*.
