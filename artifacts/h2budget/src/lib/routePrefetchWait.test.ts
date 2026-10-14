import { describe, it, expect, vi } from "vitest";

vi.mock("../pages/amex", () => ({ default: () => null }));
vi.mock("../pages/budget", () => {
  throw new Error("chunk failed");
});

import { whenRouteChunkLoaded, prefetchRoute } from "./routePrefetch";

describe("whenRouteChunkLoaded", () => {
  it("waits for a route's chunk, then says it can render now", async () => {
    const wait = whenRouteChunkLoaded("/amex");
    expect(wait).toBeInstanceOf(Promise);
    await wait;
    expect(whenRouteChunkLoaded("/amex")).toBeNull();
  });

  it("has nothing to wait for on the landing or an unknown path", () => {
    expect(whenRouteChunkLoaded("/home")).toBeNull();
    expect(whenRouteChunkLoaded("/nope")).toBeNull();
  });

  it("stops waiting on a chunk that failed (the route's own fallback takes over)", async () => {
    await whenRouteChunkLoaded("/budget");
    expect(whenRouteChunkLoaded("/budget")).toBeNull();
  });

  it("a hover warm and a render wait share one load", async () => {
    prefetchRoute("/amex");
    expect(whenRouteChunkLoaded("/amex")).toBeNull();
  });
});
