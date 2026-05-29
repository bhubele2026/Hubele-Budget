import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { inArray } from "drizzle-orm";

// (#860) Two members of the SAME household. The sidebar collapse choice is
// a PER-USER preference, so writes by one user must NOT leak to the other.
const USER_A = `uiprefA-${process.pid}-${randomUUID().slice(0, 8)}`;
const USER_B = `uiprefB-${process.pid}-${randomUUID().slice(0, 8)}`;

let TEST_HOUSEHOLD_ID: string;
// Mutable so each request can be attributed to a different signed-in user
// while keeping the SAME household — proving isolation is by user, not
// household.
let currentUser = USER_A;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: {
      userId?: string;
      actualUserId?: string;
      householdId?: string;
      householdOwnerId?: string;
    },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = currentUser;
    req.actualUserId = currentUser;
    req.householdId = TEST_HOUSEHOLD_ID;
    req.householdOwnerId = USER_A;
    next();
  },
}));

// /me hits Clerk for the GET /me identity; stub it so importing the router
// doesn't reach the network. The ui-preferences routes don't use Clerk.
vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: { getUser: vi.fn(async () => ({ id: currentUser, emailAddresses: [] })) },
  },
  getAuth: vi.fn(),
}));

import { db, userUiPreferencesTable } from "@workspace/db";
import { createTestHousehold } from "./_helpers/testHousehold";
import meRouter from "../routes/me";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(meRouter);

let server: Server;
let baseUrl: string;

async function cleanup(): Promise<void> {
  await db
    .delete(userUiPreferencesTable)
    .where(inArray(userUiPreferencesTable.userId, [USER_A, USER_B]));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(USER_A)).householdId;
  await cleanup();
  await new Promise<void>((resolve) => {
    server = createServer(app).listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await cleanup();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function getPrefs(): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/me/ui-preferences`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function putPrefs(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/me/ui-preferences`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe("(#860) per-user UI preferences (sidebar collapse)", () => {
  it("persists a user's choice and loads it back unchanged", async () => {
    currentUser = USER_A;
    expect(await getPrefs()).toEqual({});

    const saved = await putPrefs({ sidebarCollapsed: true });
    expect(saved.sidebarCollapsed).toBe(true);

    // A fresh load (a different device, same account) returns the saved value.
    expect((await getPrefs()).sidebarCollapsed).toBe(true);
  });

  it("isolates the preference per user even within the same household", async () => {
    currentUser = USER_A;
    await putPrefs({ sidebarCollapsed: true });

    // USER_B in the SAME household has not set anything yet.
    currentUser = USER_B;
    expect(await getPrefs()).toEqual({});

    // USER_B sets the opposite value.
    await putPrefs({ sidebarCollapsed: false });
    expect((await getPrefs()).sidebarCollapsed).toBe(false);

    // USER_A's value is untouched — no cross-user leakage.
    currentUser = USER_A;
    expect((await getPrefs()).sidebarCollapsed).toBe(true);
  });

  it("merges partial updates into the existing per-user record", async () => {
    currentUser = USER_A;
    await putPrefs({ sidebarCollapsed: false });

    // Seed an extra (future) key directly so we can prove the merge keeps
    // unrelated stored keys when a partial update arrives.
    await db
      .insert(userUiPreferencesTable)
      .values({
        userId: USER_A,
        preferences: { sidebarCollapsed: false, theme: "dark" },
      })
      .onConflictDoUpdate({
        target: userUiPreferencesTable.userId,
        set: { preferences: { sidebarCollapsed: false, theme: "dark" } },
      });

    const merged = await putPrefs({ sidebarCollapsed: true });
    expect(merged.sidebarCollapsed).toBe(true);
    expect(merged.theme).toBe("dark");
  });
});
