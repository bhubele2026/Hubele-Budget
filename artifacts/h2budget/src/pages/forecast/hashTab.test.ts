import { describe, it, expect } from "vitest";
import { hashTabRedirect } from "./hashTab";

describe("hashTabRedirect (D6)", () => {
  it("sends /forecast#bucket to the Review bucket", () => {
    expect(hashTabRedirect("overall", "#bucket")).toBe("/review");
  });
  it("sends /review#register to the forecast", () => {
    expect(hashTabRedirect("review", "#register")).toBe("/forecast");
  });
  it("leaves every other combination alone", () => {
    expect(hashTabRedirect("overall", "")).toBeNull();
    expect(hashTabRedirect("overall", "#register")).toBeNull();
    expect(hashTabRedirect("review", "#bucket")).toBeNull();
    expect(hashTabRedirect("review", "")).toBeNull();
  });
});
