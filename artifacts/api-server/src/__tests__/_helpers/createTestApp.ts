import { afterAll, beforeAll } from "vitest";
import { createServer, type Server } from "node:http";
import express, { type Router } from "express";

/**
 * Test helper. Boots one Express router on an ephemeral port and hands back a
 * tiny `request()` client — the ~25 lines of `createServer` / `listen(0)` /
 * `address()` / `fetch` boilerplate that every route integration test used to
 * re-implement by hand.
 *
 * It registers its own `beforeAll`/`afterAll` (server up / server down), so
 * call it once at module scope. It does NOT own auth or data: keep the
 * `vi.mock("../middlewares/requireAuth", …)` in the test file (vi.mock is
 * hoisted and file-scoped) and keep your own `beforeAll` for
 * `createTestHousehold` + row cleanup.
 *
 * Usage:
 *   const TEST_USER = `test-${process.pid}-${randomUUID().slice(0, 8)}`;
 *   let TEST_HOUSEHOLD_ID: string;
 *   vi.mock("../middlewares/requireAuth", () => ({
 *     requireAuth: (req, _res, next) => {
 *       req.userId = TEST_USER;
 *       req.actualUserId = TEST_USER;
 *       req.householdId = TEST_HOUSEHOLD_ID;
 *       req.householdOwnerId = TEST_USER;
 *       next();
 *     },
 *   }));
 *   import myRouter from "../routes/my-router";
 *   import { createTestApp } from "./_helpers/createTestApp";
 *   import { createTestHousehold } from "./_helpers/testHousehold";
 *
 *   const { request } = createTestApp(myRouter);
 *   beforeAll(async () => {
 *     TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
 *   });
 *
 *   it("…", async () => {
 *     const { status, json } = await request("POST", "/thing", { a: 1 });
 *     expect(status).toBe(200);
 *   });
 */
export function createTestApp(
  router: Router,
  opts?: { jsonLimit?: string },
): {
  app: express.Express;
  /** URL the server is listening on — only valid inside/after `beforeAll`. */
  baseUrl: () => string;
  /** `fetch` a JSON route; returns the HTTP status + parsed body (null if not JSON). */
  request: (
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<{ status: number; json: unknown }>;
} {
  const app = express();
  app.use(express.json({ limit: opts?.jsonLimit ?? "20mb" }));
  app.use(router);

  let server: Server;
  let url = "";

  beforeAll(async () => {
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no server address");
    url = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  const request = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  };

  return { app, baseUrl: () => url, request };
}
