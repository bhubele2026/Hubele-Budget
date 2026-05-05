import { describe, it, expect } from "vitest";
import { nonAmexSourceLabel } from "./dashboard";

describe("nonAmexSourceLabel — WK/MO/UN row source badge (#28)", () => {
  it("returns null for Amex-flavored sources so the badge stays hidden by default", () => {
    expect(nonAmexSourceLabel("amex")).toBeNull();
    expect(nonAmexSourceLabel("plaid:amex")).toBeNull();
    expect(nonAmexSourceLabel("AMEX")).toBeNull();
    expect(nonAmexSourceLabel(null)).toBeNull();
    expect(nonAmexSourceLabel(undefined)).toBeNull();
    expect(nonAmexSourceLabel("")).toBeNull();
  });

  it("strips the `plaid:` prefix so the badge reads as the bank name", () => {
    expect(nonAmexSourceLabel("plaid:chase")).toBe("chase");
    expect(nonAmexSourceLabel("plaid:capitalone")).toBe("capitalone");
    expect(nonAmexSourceLabel("plaid:bank")).toBe("bank");
  });

  it("passes manual / non-Plaid sources through verbatim (lowercased)", () => {
    expect(nonAmexSourceLabel("manual")).toBe("manual");
    expect(nonAmexSourceLabel("Manual")).toBe("manual");
    expect(nonAmexSourceLabel("cash")).toBe("cash");
  });
});
