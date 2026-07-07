# TDD & the CI green-gate

How we add behavior to H2 Budget: write a failing test first, make it pass, ship
behind a PR that CI must green before it can merge. Because the Replit deploy
pulls `main`, **a protected `main` is the deploy gate** — nothing red reaches a
deployable commit.

## The loop

1. **Red** — write a test that asserts the behavior you want and fails for the
   right reason (run it, watch it fail).
2. **Green** — implement the smallest change that makes it pass.
3. **Refactor** — clean up with the test still green.
4. **PR** — branch per task, open a PR. CI runs `typecheck`, `web-tests`,
   `api-tests`, and `build` (see below). It must be green.
5. **Merge** — branch protection requires those checks + review before merge, so
   `main` stays deployable.

Never weaken a test to go green (CLAUDE.md). If a financial number is involved,
the test asserts the number our code computes — the AI never does arithmetic.

## What CI runs (`.github/workflows/ci.yml`)

Fires on every push (all branches) and every PR. Four required jobs, in parallel:

| Job | Command | Covers |
| --- | --- | --- |
| `typecheck` | `pnpm run typecheck` | types across all packages |
| `web-tests` | `pnpm --filter ./artifacts/h2budget run test` | 90+ jsdom unit tests, no DB |
| `api-tests` | `pnpm --filter ./artifacts/api-server run test` | 110+ integration tests vs a real Postgres 16 |
| `build` | `pnpm run build` | the exact production build Replit deploys |

`e2e` (Playwright) is opt-in behind the `E2E_ENABLED` repo variable until Clerk
test credentials exist — deferral, not a weakened gate.

Run the same gates locally before pushing:

```bash
pnpm run typecheck
pnpm --filter ./artifacts/h2budget run test
pnpm --filter ./artifacts/api-server run test   # needs a Postgres at $DATABASE_URL
pnpm run build
```

## Writing a test

### Pure logic (no DB) — the easy case

Import the function and assert. No server, no database. Example:
`artifacts/api-server/src/__tests__/billsMonthlyTotal.test.ts`.

### API route (integration) — use the shared harness

The database is real: the api-server `pretest` hook (`pnpm --filter @workspace/db
push`) pushes the current schema to whatever `DATABASE_URL` points at (the
Postgres service in CI, your dev DB locally). Two helpers remove the boilerplate:

- **`_helpers/createTestApp.ts`** — boots one router on an ephemeral port and
  returns a `request(method, path, body)` client. It owns the server
  `beforeAll`/`afterAll`.
- **`_helpers/testHousehold.ts`** — `createTestHousehold(userId)` seeds a real
  household + owner row so the household-scoped route layer finds your rows.

`requireAuth` is mocked in the test file itself (vi.mock is hoisted and
file-scoped, so it can't live in a helper). Worked example:
`artifacts/api-server/src/__tests__/uncategorizeByIdsCap.integration.test.ts`.

Skeleton:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const TEST_USER = `test-${process.pid}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: any, _res: unknown, next: () => void) => {
    req.userId = TEST_USER;
    req.actualUserId = TEST_USER;
    req.householdId = TEST_HOUSEHOLD_ID;
    req.householdOwnerId = TEST_USER;
    next();
  },
}));

import myRouter from "../routes/my-router";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";

const { request } = createTestApp(myRouter);

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  // clean any rows this test owns
});
afterAll(async () => {
  // clean up rows this test owns
});

it("does the thing", async () => {
  const { status, json } = await request("POST", "/thing", { a: 1 });
  expect(status).toBe(200);
});
```

Notes:
- Tests run serially (`singleFork`) against one shared DB — always scope
  cleanup/queries to your unique `TEST_USER` so tests don't step on each other.
- New/changed API surface: edit `lib/api-spec/openapi.yaml`, run codegen, then
  consume the generated hook — never hand-write client hooks (CLAUDE.md §4).

### Web component/unit (jsdom)

Vitest + jsdom (`artifacts/h2budget/vitest.config.ts`), setup polyfills
`matchMedia`. Put files next to the code as `*.test.ts(x)`.
