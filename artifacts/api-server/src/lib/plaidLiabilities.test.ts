import { describe, it, expect } from "vitest";
import { isLiabilitiesNotEnabled } from "./plaidLiabilities";

const plaidErr = (error_code: string, error_message = "") => ({
  response: { data: { error_code, error_message } },
});

describe("isLiabilitiesNotEnabled", () => {
  it("treats the not-approved error codes as benign", () => {
    expect(isLiabilitiesNotEnabled(plaidErr("INVALID_PRODUCT"))).toBe(true);
    expect(isLiabilitiesNotEnabled(plaidErr("PRODUCTS_NOT_SUPPORTED"))).toBe(true);
    expect(isLiabilitiesNotEnabled(plaidErr("PRODUCT_NOT_ENABLED"))).toBe(true);
    expect(isLiabilitiesNotEnabled(plaidErr("ADDITIONAL_CONSENT_REQUIRED"))).toBe(
      true,
    );
  });

  it("treats the 'client does not have access to products' message as benign (the false-reconnect bug)", () => {
    expect(
      isLiabilitiesNotEnabled(
        plaidErr(
          "INVALID_FIELD",
          'client does not have access to products: ["liabilities"]',
        ),
      ),
    ).toBe(true);
    expect(
      isLiabilitiesNotEnabled(
        plaidErr(
          "INVALID_INPUT",
          "client is not authorized to access the following products: [liabilities]",
        ),
      ),
    ).toBe(true);
  });

  it("does NOT treat a real login/reauth failure as benign", () => {
    expect(
      isLiabilitiesNotEnabled(
        plaidErr("ITEM_LOGIN_REQUIRED", "the login details of this item have changed"),
      ),
    ).toBe(false);
  });

  it("returns false for an unrelated/unshaped error", () => {
    expect(isLiabilitiesNotEnabled(new Error("network blip"))).toBe(false);
    expect(isLiabilitiesNotEnabled(null)).toBe(false);
  });
});
