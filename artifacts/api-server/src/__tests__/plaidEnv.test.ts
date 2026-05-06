import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  getPlaidEnv,
  isValidPlaidAccessToken,
  PLAID_VALID_ENVS,
} from "../lib/plaid";
import { tokenEnv } from "../routes/plaid";

describe("getPlaidEnv", () => {
  const original = process.env.PLAID_ENV;
  beforeEach(() => {
    delete process.env.PLAID_ENV;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.PLAID_ENV;
    else process.env.PLAID_ENV = original;
  });

  it("throws when PLAID_ENV is missing", () => {
    expect(() => getPlaidEnv()).toThrow(/PLAID_ENV is required/);
  });

  it("throws when PLAID_ENV is empty string", () => {
    process.env.PLAID_ENV = "";
    expect(() => getPlaidEnv()).toThrow(/PLAID_ENV is required/);
  });

  it("throws when PLAID_ENV is invalid", () => {
    process.env.PLAID_ENV = "staging";
    expect(() => getPlaidEnv()).toThrow(/PLAID_ENV="staging" is invalid/);
  });

  it("accepts and lowercases each valid env", () => {
    for (const env of PLAID_VALID_ENVS) {
      process.env.PLAID_ENV = env;
      expect(getPlaidEnv()).toBe(env);
      process.env.PLAID_ENV = env.toUpperCase();
      expect(getPlaidEnv()).toBe(env);
    }
  });
});

describe("tokenEnv", () => {
  it("returns 'sandbox' for sandbox-prefixed tokens", () => {
    expect(tokenEnv("access-sandbox-abc123")).toBe("sandbox");
  });

  it("returns 'development' for development-prefixed tokens", () => {
    expect(tokenEnv("access-development-deadbeef")).toBe("development");
  });

  it("returns 'production' for production-prefixed tokens", () => {
    expect(tokenEnv("access-production-cafef00d")).toBe("production");
  });

  it("lowercases the env segment", () => {
    expect(tokenEnv("access-SANDBOX-xyz")).toBe("sandbox");
  });

  it("returns null for null/undefined/empty tokens", () => {
    expect(tokenEnv(null)).toBeNull();
    expect(tokenEnv(undefined)).toBeNull();
    expect(tokenEnv("")).toBeNull();
  });

  it("returns null for malformed tokens that don't match the prefix", () => {
    expect(tokenEnv("nope")).toBeNull();
    expect(tokenEnv("synthetic-no-access")).toBeNull();
    expect(tokenEnv("access-")).toBeNull();
    expect(tokenEnv("accesssandbox-foo")).toBeNull();
    expect(tokenEnv("ACCESS-sandbox-foo")).toBeNull();
  });
});

// (#366) Centralized guard for the shape of a stored Plaid access
// token. Every read/write site that touches `plaid_items.access_token`
// runs through this regex BEFORE calling Plaid so a poisoned row never
// produces an opaque "Request failed with status code 400" chip.
describe("isValidPlaidAccessToken", () => {
  it("accepts a canonical sandbox / development / production token", () => {
    expect(
      isValidPlaidAccessToken("access-sandbox-abc123-def456-7890"),
    ).toBe(true);
    expect(
      isValidPlaidAccessToken("access-development-aaaa-bbbb-cccc"),
    ).toBe(true);
    expect(
      isValidPlaidAccessToken("access-production-deadbeef-cafef00d"),
    ).toBe(true);
  });

  it("accepts the entire alphanumeric+hyphen opaque blob Plaid actually mints", () => {
    expect(
      isValidPlaidAccessToken(
        "access-production-1a2b3c4d-5e6f-7890-abcd-ef0123456789",
      ),
    ).toBe(true);
  });

  // (#367) The previous `[A-Za-z0-9-]+` suffix regex was too strict —
  // Plaid documents access tokens as opaque, and we have observed real
  // tokens that contain underscores. Rejecting them poisoned the
  // reconnect loop because the synthetic ITEM_LOGIN_REQUIRED would
  // re-flag the row even after a successful Plaid Link relink.
  it("accepts opaque tokens whose suffix contains underscores or mixed URL-safe chars", () => {
    expect(
      isValidPlaidAccessToken("access-production-abc_123_def-456"),
    ).toBe(true);
    expect(
      isValidPlaidAccessToken("access-sandbox-AbC_xYz-9_8_7-zzz"),
    ).toBe(true);
    // tilde, plus, equals, hash, percent — all URL-safe printable ASCII
    expect(
      isValidPlaidAccessToken("access-production-abc~def+ghi=jkl#mno%pqr"),
    ).toBe(true);
  });

  it("rejects null, undefined, empty string, and non-string values", () => {
    expect(isValidPlaidAccessToken(null)).toBe(false);
    expect(isValidPlaidAccessToken(undefined)).toBe(false);
    expect(isValidPlaidAccessToken("")).toBe(false);
    // Belt + suspenders: TS callers shouldn't be able to pass these,
    // but a bad write upstream could land a JSON-stringified value in
    // the column. The runtime guard must still reject it.
    expect(isValidPlaidAccessToken(0 as unknown as string)).toBe(false);
    expect(isValidPlaidAccessToken({} as unknown as string)).toBe(false);
  });

  it("rejects unknown environment segments", () => {
    expect(isValidPlaidAccessToken("access-staging-abc")).toBe(false);
    expect(isValidPlaidAccessToken("access-prod-abc")).toBe(false);
    expect(isValidPlaidAccessToken("access-dev-abc")).toBe(false);
  });

  it("rejects truncated, prefix-only, and missing-opaque shapes (the actual #366 failure mode)", () => {
    expect(isValidPlaidAccessToken("access-")).toBe(false);
    expect(isValidPlaidAccessToken("access-sandbox-")).toBe(false);
    expect(isValidPlaidAccessToken("access-production-")).toBe(false);
    expect(isValidPlaidAccessToken("access-sandbox")).toBe(false);
  });

  it("rejects wrong prefix capitalization (Plaid always lowercases 'access')", () => {
    expect(isValidPlaidAccessToken("Access-sandbox-abc")).toBe(false);
    expect(isValidPlaidAccessToken("ACCESS-sandbox-abc")).toBe(false);
  });

  it("rejects clearly broken shapes (whitespace, JSON-quoted, multi-line)", () => {
    // Whitespace / control chars are below printable ASCII — rejected.
    expect(isValidPlaidAccessToken("access-sandbox-abc 123")).toBe(false);
    expect(isValidPlaidAccessToken("access-sandbox-abc\n")).toBe(false);
    expect(isValidPlaidAccessToken("access-sandbox-abc\t123")).toBe(false);
    // JSON-stringified value (the actual poison shape we've observed):
    // leading quote breaks the prefix, trailing quote breaks the suffix.
    expect(isValidPlaidAccessToken('"access-sandbox-abc"')).toBe(false);
    expect(isValidPlaidAccessToken("'access-sandbox-abc'")).toBe(false);
  });

  // (#367 follow-up) Plaid documents access tokens as opaque. Don't
  // second-guess the contract by blocking individual punctuation chars
  // — if the prefix matches and the suffix is printable-ASCII without
  // whitespace, we accept. This prevents false-malformed flags if
  // Plaid ever expands the token alphabet (base64 padding, URL-safe
  // encodings, etc.).
  it("accepts opaque suffixes containing punctuation Plaid could plausibly emit", () => {
    expect(isValidPlaidAccessToken("access-production-abc.123")).toBe(true);
    expect(isValidPlaidAccessToken("access-production-abc/123")).toBe(true);
    expect(isValidPlaidAccessToken("access-production-abc+def=")).toBe(true);
    expect(isValidPlaidAccessToken("access-production-abc:123")).toBe(true);
  });
});
