import { describe, it, expect, vi } from "vitest";

vi.mock("react-plaid-link", () => ({ usePlaidLink: () => ({ open: () => {}, ready: false }) }));
vi.mock("@workspace/api-client-react", () => ({}));

import {
  DEFAULT_RETURN_TO,
  PLAID_LINK_TOKEN_STORAGE_KEY,
  PLAID_RETURN_TO_STORAGE_KEY,
  isClassicPath,
  safeReturnPath,
} from "./PlaidOAuth";

describe("Plaid OAuth return — where a finished link goes back to", () => {
  it("reads the SAME storage keys the classic Plaid Link button writes", () => {
    // Plaid's registered redirect URI is /plaid-oauth, now served by H2, so a
    // link the classic app starts must finish here. Renaming either key
    // silently strands every OAuth bank link.
    expect(PLAID_LINK_TOKEN_STORAGE_KEY).toBe("h2:plaid:link_token");
    expect(PLAID_RETURN_TO_STORAGE_KEY).toBe("h2:plaid:return_to");
  });

  it("defaults to Today", () => {
    expect(DEFAULT_RETURN_TO).toBe("/");
    expect(safeReturnPath(null)).toBe("/");
  });

  it("honours app-relative paths only (no open redirect)", () => {
    expect(safeReturnPath("/classic/settings")).toBe("/classic/settings");
    expect(safeReturnPath("/")).toBe("/");
    for (const bad of ["//evil.example", "https://evil.example", "javascript:alert(1)", "settings", ""]) {
      expect(safeReturnPath(bad)).toBe("/");
    }
  });

  it("a classic path is another app: it needs a full page load", () => {
    expect(isClassicPath("/classic")).toBe(true);
    expect(isClassicPath("/classic/settings")).toBe(true);
    expect(isClassicPath("/classic?x=1")).toBe(true);
    expect(isClassicPath("/")).toBe(false);
    expect(isClassicPath("/classical")).toBe(false);
  });
});
