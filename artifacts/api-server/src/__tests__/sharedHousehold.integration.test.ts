import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";

const OWNER_ID = `owner-${process.pid}-${randomUUID().slice(0, 8)}`;
const MEMBER_ID = `member-${process.pid}-${randomUUID().slice(0, 8)}`;
const STRANGER_ID = `stranger-${process.pid}-${randomUUID().slice(0, 8)}`;
const OWNER_EMAIL = `owner-${process.pid}-${randomUUID().slice(0, 6)}@example.test`;
const MEMBER_EMAIL = `member-${process.pid}-${randomUUID().slice(0, 6)}@example.test`;
const STRANGER_EMAIL = `stranger-${process.pid}-${randomUUID().slice(0, 6)}@example.test`;

// Pin OWNER_EMAIL before requireOwner module loads so getOwnerEmail() reads it.
process.env.OWNER_EMAIL = OWNER_EMAIL;

// Track which emails have been "invited" (and accepted) by the owner.
// MEMBER_EMAIL is in this set; STRANGER_EMAIL is NOT — that's the
// invitation gate that proves uninvited Clerk accounts can't see
// household data.
const acceptedInvitations = new Set<string>([MEMBER_EMAIL.toLowerCase()]);

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUserList: vi.fn(async (opts: { emailAddress?: string[] }) => {
        const target = opts.emailAddress?.[0]?.toLowerCase().trim();
        if (target === OWNER_EMAIL.toLowerCase()) {
          return { data: [{ id: OWNER_ID }] };
        }
        return { data: [] };
      }),
      getUser: vi.fn(async (id: string) => {
        const map: Record<string, string> = {
          [OWNER_ID]: OWNER_EMAIL,
          [MEMBER_ID]: MEMBER_EMAIL,
          [STRANGER_ID]: STRANGER_EMAIL,
        };
        const email = map[id];
        if (!email) throw new Error("not found");
        return {
          id,
          primaryEmailAddressId: "primary",
          emailAddresses: [{ id: "primary", emailAddress: email }],
        };
      }),
    },
    invitations: {
      getInvitationList: vi.fn(
        async (opts: { status?: string; limit?: number; offset?: number }) => {
          if (opts.status !== "accepted") return { data: [] };
          if ((opts.offset ?? 0) > 0) return { data: [] };
          return {
            data: Array.from(acceptedInvitations).map((emailAddress) => ({
              emailAddress,
            })),
          };
        },
      ),
    },
  },
  getAuth: vi.fn(),
}));

import {
  db,
  profilesTable,
  transactionsTable,
  householdsTable,
  householdMembersTable,
} from "@workspace/db";
import {
  requireAuth,
  _resetHouseholdCacheForTests,
} from "../middlewares/requireAuth";

async function cleanupAll(): Promise<void> {
  const ids = [OWNER_ID, MEMBER_ID, STRANGER_ID];
  await db
    .delete(transactionsTable)
    .where(inArray(transactionsTable.userId, ids));
  await db
    .delete(householdMembersTable)
    .where(inArray(householdMembersTable.userId, ids));
  // Households orphaned by the cascade above? Owner-by-userId rows aren't
  // tracked on households directly; we just clean up profiles which carry
  // a back-pointer in legacy code paths.
  await db.delete(profilesTable).where(inArray(profilesTable.id, ids));
}

beforeAll(async () => {
  await cleanupAll();
});

afterAll(async () => {
  await cleanupAll();
});

beforeEach(async () => {
  _resetHouseholdCacheForTests();
  await cleanupAll();
});

interface FakeReq {
  userId?: string;
  actualUserId?: string;
  householdId?: string;
  householdOwnerId?: string;
  log: { warn: (...a: unknown[]) => void };
}

async function callRequireAuthAs(actualUserId: string): Promise<FakeReq> {
  const { getAuth } = await import("@clerk/express");
  (getAuth as ReturnType<typeof vi.fn>).mockReturnValueOnce({
    userId: actualUserId,
    sessionClaims: undefined,
  });
  const req: FakeReq = { log: { warn: () => undefined } };
  await new Promise<void>((resolve, reject) => {
    requireAuth(
      req as unknown as Parameters<typeof requireAuth>[0],
      {
        status() {
          return {
            json() {
              reject(new Error("unauthorized"));
            },
          };
        },
      } as unknown as Parameters<typeof requireAuth>[1],
      (err?: unknown) => (err ? reject(err) : resolve()),
    );
  });
  return req;
}

describe("(#623) shared household data model", () => {
  it("invited member shares the owner's household via household_members membership", async () => {
    // Owner signs in first → bootstraps household + self-membership.
    const ownerReq = await callRequireAuthAs(OWNER_ID);
    expect(ownerReq.actualUserId).toBe(OWNER_ID);
    expect(ownerReq.userId).toBe(OWNER_ID);
    expect(ownerReq.householdOwnerId).toBe(OWNER_ID);
    const ownerHouseholdId = ownerReq.householdId!;
    expect(ownerHouseholdId).toBeTruthy();

    // Owner inserts a transaction, scoped to the owner household.
    await db.insert(transactionsTable).values({
      userId: OWNER_ID,
      householdId: ownerHouseholdId,
      occurredOn: "2026-05-01",
      description: "Shared household coffee",
      amount: "-4.50",
      source: "manual",
    });

    // Invited member signs in → joins the owner's household via the
    // accepted-invitation bootstrap; req.userId stays the actor's id
    // (no remap), but req.householdId points at the owner household so
    // every household-scoped query returns the owner's data.
    const memberReq = await callRequireAuthAs(MEMBER_ID);
    expect(memberReq.actualUserId).toBe(MEMBER_ID);
    expect(memberReq.userId).toBe(MEMBER_ID);
    expect(memberReq.householdId).toBe(ownerHouseholdId);
    expect(memberReq.householdOwnerId).toBe(OWNER_ID);

    // Membership row persists so subsequent requests skip the Clerk
    // invitation lookup.
    const memberRows = await db
      .select()
      .from(householdMembersTable)
      .where(eq(householdMembersTable.userId, MEMBER_ID));
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0].householdId).toBe(ownerHouseholdId);

    // Member's data query (keyed on req.householdId) returns the owner's row.
    const rowsAsMember = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.householdId, memberReq.householdId!));
    expect(rowsAsMember.map((r) => r.description)).toContain(
      "Shared household coffee",
    );
  });

  it("uninvited stranger gets their OWN household — no access to the owner's data", async () => {
    // Bootstrap owner household first.
    const ownerReq = await callRequireAuthAs(OWNER_ID);
    const ownerHouseholdId = ownerReq.householdId!;
    await db.insert(transactionsTable).values({
      userId: OWNER_ID,
      householdId: ownerHouseholdId,
      occurredOn: "2026-05-01",
      description: "Owner-only secret",
      amount: "-9.99",
      source: "manual",
    });

    // STRANGER_EMAIL is NOT in acceptedInvitations and is not the owner.
    // requireAuth must self-isolate them into their own household.
    const strangerReq = await callRequireAuthAs(STRANGER_ID);
    expect(strangerReq.actualUserId).toBe(STRANGER_ID);
    expect(strangerReq.userId).toBe(STRANGER_ID);
    expect(strangerReq.householdOwnerId).toBe(STRANGER_ID);
    expect(strangerReq.householdId).toBeTruthy();
    expect(strangerReq.householdId).not.toBe(ownerHouseholdId);

    // Their household-scoped query returns nothing — owner's row is invisible.
    const rowsAsStranger = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.householdId, strangerReq.householdId!));
    expect(rowsAsStranger).toHaveLength(0);

    // The stranger's household_members row points at their own household,
    // not the owner's — defense in depth against any leak path.
    const [strangerMembership] = await db
      .select()
      .from(householdMembersTable)
      .where(eq(householdMembersTable.userId, STRANGER_ID));
    expect(strangerMembership?.householdId).toBe(strangerReq.householdId);
    expect(strangerMembership?.householdId).not.toBe(ownerHouseholdId);
  });

  it("the owner's household exists in the households table and is unaffected by stranger sign-ins", async () => {
    const ownerReq = await callRequireAuthAs(OWNER_ID);
    const ownerHouseholdId = ownerReq.householdId!;
    await db.insert(transactionsTable).values({
      userId: OWNER_ID,
      householdId: ownerHouseholdId,
      occurredOn: "2026-05-01",
      description: "Mortgage",
      amount: "-1500.00",
      source: "manual",
    });

    // A stranger signs in first and gets self-isolated.
    await callRequireAuthAs(STRANGER_ID);

    // Owner signs in again — same household resolved.
    const ownerReq2 = await callRequireAuthAs(OWNER_ID);
    expect(ownerReq2.userId).toBe(OWNER_ID);
    expect(ownerReq2.householdId).toBe(ownerHouseholdId);

    const rows = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.householdId, ownerReq2.householdId!));
    expect(rows.map((r) => r.description)).toContain("Mortgage");

    // households table has exactly one row for the owner.
    const ownerHouseholds = await db
      .select()
      .from(householdsTable)
      .where(eq(householdsTable.id, ownerHouseholdId));
    expect(ownerHouseholds).toHaveLength(1);
  });
});
