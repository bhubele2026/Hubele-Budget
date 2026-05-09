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

import { db, profilesTable, transactionsTable } from "@workspace/db";
import {
  requireAuth,
  _resetHouseholdCacheForTests,
} from "../middlewares/requireAuth";

async function cleanupAll(): Promise<void> {
  const ids = [OWNER_ID, MEMBER_ID, STRANGER_ID];
  await db
    .delete(transactionsTable)
    .where(inArray(transactionsTable.userId, ids));
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
  it("invited member sees the owner's transactions through req.userId remap", async () => {
    // Owner inserts a transaction.
    await db.insert(transactionsTable).values({
      userId: OWNER_ID,
      occurredOn: "2026-05-01",
      description: "Shared household coffee",
      amount: "-4.50",
      source: "manual",
    });

    // Owner signs in → resolves household = self
    const ownerReq = await callRequireAuthAs(OWNER_ID);
    expect(ownerReq.actualUserId).toBe(OWNER_ID);
    expect(ownerReq.userId).toBe(OWNER_ID);

    // Invited member signs in → req.userId remapped to OWNER_ID,
    // actualUserId preserved as MEMBER_ID
    const memberReq = await callRequireAuthAs(MEMBER_ID);
    expect(memberReq.actualUserId).toBe(MEMBER_ID);
    expect(memberReq.userId).toBe(OWNER_ID);

    // Profile row persists the resolution so subsequent requests skip Clerk
    const [memberProfile] = await db
      .select()
      .from(profilesTable)
      .where(eq(profilesTable.id, MEMBER_ID));
    expect(memberProfile?.householdOwnerId).toBe(OWNER_ID);

    // Member's data query (keyed on req.userId) returns the owner's row.
    const rowsAsMember = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, memberReq.userId!));
    expect(rowsAsMember.map((r) => r.description)).toContain(
      "Shared household coffee",
    );
  });

  it("uninvited stranger CANNOT access the owner's household — household isolation holds", async () => {
    // Seed a transaction in the owner's household.
    await db.insert(transactionsTable).values({
      userId: OWNER_ID,
      occurredOn: "2026-05-01",
      description: "Owner-only secret",
      amount: "-9.99",
      source: "manual",
    });

    // STRANGER_EMAIL is NOT in acceptedInvitations. The stranger holds
    // a valid Clerk session but was never invited.
    const strangerReq = await callRequireAuthAs(STRANGER_ID);

    // Defense in depth: req.userId must NOT be remapped to the owner.
    expect(strangerReq.actualUserId).toBe(STRANGER_ID);
    expect(strangerReq.userId).toBe(STRANGER_ID);

    // Their data query returns nothing — they cannot see the owner's row.
    const rowsAsStranger = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, strangerReq.userId!));
    expect(rowsAsStranger).toHaveLength(0);

    // Persisted profile records the self-mapping (no leak path on retry).
    const [strangerProfile] = await db
      .select()
      .from(profilesTable)
      .where(eq(profilesTable.id, STRANGER_ID));
    expect(strangerProfile?.householdOwnerId).toBe(STRANGER_ID);
  });

  it("the owner sees their own household and is unaffected by stranger profiles", async () => {
    await db.insert(transactionsTable).values({
      userId: OWNER_ID,
      occurredOn: "2026-05-01",
      description: "Mortgage",
      amount: "-1500.00",
      source: "manual",
    });

    // A stranger signs in first and records a self-mapped profile.
    await callRequireAuthAs(STRANGER_ID);

    // Owner signs in.
    const ownerReq = await callRequireAuthAs(OWNER_ID);
    expect(ownerReq.userId).toBe(OWNER_ID);
    const rows = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, ownerReq.userId!));
    expect(rows.map((r) => r.description)).toContain("Mortgage");
  });
});
