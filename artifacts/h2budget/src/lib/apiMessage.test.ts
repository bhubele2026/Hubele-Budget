import { describe, it, expect } from "vitest";
import { OWNER_ONLY, apiMessage, ownerOnlyOr } from "./apiMessage";

describe("apiMessage", () => {
  it("the server's own words first, then owner-only for a 403, else the fallback", () => {
    expect(apiMessage({ status: 429, data: { error: "That is 3 test texts today." } }, "x")).toBe("That is 3 test texts today.");
    expect(apiMessage({ status: 403, data: null }, "x")).toBe(OWNER_ONLY);
    expect(apiMessage({ status: 500, data: { error: "  " } }, "Try again.")).toBe("Try again.");
    expect(apiMessage(null, "Try again.")).toBe("Try again.");
  });

  it("ownerOnlyOr never shows a server code", () => {
    expect(ownerOnlyOr({ status: 403, data: { error: "owner_only" } }, "x")).toBe(OWNER_ONLY);
    expect(ownerOnlyOr({ status: 500 }, "Couldn't save that.")).toBe("Couldn't save that.");
  });
});
