import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";
import express, { type Response, type NextFunction } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Products } from "plaid";

const TEST_USER = "link-token-test-user";

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = TEST_USER;
    next();
  },
}));

const linkTokenCreateMock: Mock = vi.fn();

async function setupApp(optionalProducts: Products[]): Promise<{
  server: Server;
  baseUrl: string;
}> {
  vi.resetModules();
  linkTokenCreateMock.mockReset();
  linkTokenCreateMock.mockResolvedValue({
    data: {
      link_token: "link-test-token-abc",
      expiration: "2099-01-01T00:00:00Z",
    },
  });

  vi.doMock("../lib/plaid", async () => {
    const actual = await vi.importActual<typeof import("../lib/plaid")>(
      "../lib/plaid",
    );
    return {
      ...actual,
      plaid: () => ({ linkTokenCreate: linkTokenCreateMock }),
      PLAID_OPTIONAL_PRODUCTS: optionalProducts,
    };
  });

  const { default: router } = await import("../routes/plaid");

  const app = express();
  app.use(express.json());
  app.use((req: { log?: unknown }, _res: Response, next: NextFunction) => {
    req.log = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
    next();
  });
  app.use(router);

  const server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  const port = (addr as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe("POST /plaid/link-token request payload", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((res) => server!.close(() => res()));
      server = null;
    }
    vi.doUnmock("../lib/plaid");
  });

  it("omits optional_products entirely when no optional products are configured", async () => {
    const ctx = await setupApp([]);
    server = ctx.server;

    const res = await fetch(`${ctx.baseUrl}/plaid/link-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);

    expect(linkTokenCreateMock).toHaveBeenCalledTimes(1);
    const arg = linkTokenCreateMock.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    // The fix in #171: the field must be ABSENT, not present-and-empty.
    expect(Object.prototype.hasOwnProperty.call(arg, "optional_products")).toBe(
      false,
    );
    // Required fields are still sent
    expect(arg.products).toEqual([Products.Transactions]);
    expect(arg.country_codes).toBeDefined();
    expect((arg.user as { client_user_id?: string })?.client_user_id).toBe(
      TEST_USER,
    );
  });

  it("includes optional_products when at least one is configured", async () => {
    const ctx = await setupApp([Products.Liabilities]);
    server = ctx.server;

    const res = await fetch(`${ctx.baseUrl}/plaid/link-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);

    expect(linkTokenCreateMock).toHaveBeenCalledTimes(1);
    const arg = linkTokenCreateMock.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(arg.optional_products).toEqual([Products.Liabilities]);
    expect(arg.products).toEqual([Products.Transactions]);
  });

  it("includes optional_products with multiple entries when multiple are configured", async () => {
    const ctx = await setupApp([Products.Liabilities, Products.Investments]);
    server = ctx.server;

    const res = await fetch(`${ctx.baseUrl}/plaid/link-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);

    const arg = linkTokenCreateMock.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(arg.optional_products).toEqual([
      Products.Liabilities,
      Products.Investments,
    ]);
  });
});

describe("POST /plaid/link-token error surfacing", () => {
  let server: Server | null = null;

  beforeEach(() => {
    linkTokenCreateMock.mockReset();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((res) => server!.close(() => res()));
      server = null;
    }
    vi.doUnmock("../lib/plaid");
  });

  it("surfaces Plaid INVALID_PRODUCT error code/message in the JSON body", async () => {
    const ctx = await setupApp([Products.Liabilities]);
    server = ctx.server;

    // Simulate the exact failure mode from #171: requesting an unapproved
    // optional product returns INVALID_PRODUCT from Plaid. Override the
    // default resolution that setupApp installed.
    linkTokenCreateMock.mockReset();
    linkTokenCreateMock.mockRejectedValueOnce({
      response: {
        data: {
          error_code: "INVALID_PRODUCT",
          error_message:
            "client is not authorized to access the following products: [\"liabilities\"]",
        },
      },
    });

    const res = await fetch(`${ctx.baseUrl}/plaid/link-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.code).toBe("INVALID_PRODUCT");
    expect(body.error).toMatch(/liabilities/);
  });
});
