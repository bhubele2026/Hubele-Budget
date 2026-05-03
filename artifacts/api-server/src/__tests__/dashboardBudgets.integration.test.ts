import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `test-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = TEST_USER;
    next();
  },
}));

import { db, dashboardBudgetsTable, settingsTable } from "@workspace/db";
import dashboardBudgetsRouter from "../routes/dashboardBudgets";

const app = express();
app.use(express.json());
app.use(dashboardBudgetsRouter);

let server: Server;
let baseUrl: string;

async function cleanup(): Promise<void> {
  await db
    .delete(dashboardBudgetsTable)
    .where(eq(dashboardBudgetsTable.userId, TEST_USER));
  await db.delete(settingsTable).where(eq(settingsTable.userId, TEST_USER));
}

beforeAll(async () => {
  await cleanup();
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await cleanup();
  await new Promise<void>((res) => server.close(() => res()));
});

beforeEach(async () => {
  await cleanup();
});

type BudgetRow = {
  id: string;
  bucket: string;
  periodKey: string;
  amount: string;
};

async function getScoped(bucket: string, periodKey: string): Promise<BudgetRow[]> {
  const r = await fetch(
    `${baseUrl}/dashboard-budgets?bucket=${bucket}&periodKey=${periodKey}`,
  );
  expect(r.status).toBe(200);
  return (await r.json()) as BudgetRow[];
}

describe("GET /dashboard-budgets — Settings allowance fallback", () => {
  it("returns the Settings allowance amount when no override row exists", async () => {
    await db.insert(settingsTable).values({
      userId: TEST_USER,
      weeklyAllowanceAmount: "150.00",
      monthlyAllowanceAmount: "400.00",
      unplannedAllowanceAmount: "75.00",
    });

    const weekly = await getScoped("weekly", "2026-05");
    expect(weekly).toHaveLength(1);
    expect(weekly[0].bucket).toBe("weekly");
    expect(weekly[0].periodKey).toBe("2026-05");
    expect(weekly[0].amount).toBe("150.00");
    // Synthetic fallback rows use a sentinel id so the client knows it isn't a DB row.
    expect(weekly[0].id).toBe("default:weekly:2026-05");

    const monthly = await getScoped("monthly", "2026-05");
    expect(monthly[0].amount).toBe("400.00");
    const unplanned = await getScoped("unplanned", "2026-05");
    expect(unplanned[0].amount).toBe("75.00");
  });

  it("falls back to '0' when the user has no Settings row at all", async () => {
    const weekly = await getScoped("weekly", "2026-05");
    expect(weekly).toHaveLength(1);
    expect(weekly[0].amount).toBe("0");
    expect(weekly[0].id).toBe("default:weekly:2026-05");
  });

  it("returns the per-month override row when one exists, ignoring Settings", async () => {
    await db.insert(settingsTable).values({
      userId: TEST_USER,
      weeklyAllowanceAmount: "150.00",
    });
    await db.insert(dashboardBudgetsTable).values({
      userId: TEST_USER,
      bucket: "weekly",
      periodKey: "2026-05",
      amount: "222.00",
    });

    const rows = await getScoped("weekly", "2026-05");
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe("222.00");
    // The override is a real DB row (uuid id), not the synthetic fallback sentinel.
    expect(rows[0].id).not.toBe("default:weekly:2026-05");

    // A different period for the same bucket still falls back to Settings.
    const otherMonth = await getScoped("weekly", "2026-06");
    expect(otherMonth).toHaveLength(1);
    expect(otherMonth[0].amount).toBe("150.00");
    expect(otherMonth[0].id).toBe("default:weekly:2026-06");
  });
});
