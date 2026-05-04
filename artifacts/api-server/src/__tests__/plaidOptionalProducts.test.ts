import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Products } from "plaid";
import { parseOptionalProductsFromEnv } from "../lib/plaid";

describe("parseOptionalProductsFromEnv", () => {
  const original = process.env.PLAID_OPTIONAL_PRODUCTS_CSV;

  beforeEach(() => {
    delete process.env.PLAID_OPTIONAL_PRODUCTS_CSV;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.PLAID_OPTIONAL_PRODUCTS_CSV;
    } else {
      process.env.PLAID_OPTIONAL_PRODUCTS_CSV = original;
    }
  });

  it("returns [] when the env var is unset", () => {
    expect(parseOptionalProductsFromEnv()).toEqual([]);
  });

  it("returns [] when the env var is an empty string", () => {
    process.env.PLAID_OPTIONAL_PRODUCTS_CSV = "";
    expect(parseOptionalProductsFromEnv()).toEqual([]);
  });

  it("returns [] when the env var is only whitespace", () => {
    process.env.PLAID_OPTIONAL_PRODUCTS_CSV = "   ";
    expect(parseOptionalProductsFromEnv()).toEqual([]);
  });

  it("parses a single valid product name", () => {
    process.env.PLAID_OPTIONAL_PRODUCTS_CSV = "liabilities";
    expect(parseOptionalProductsFromEnv()).toEqual([Products.Liabilities]);
  });

  it("parses a comma-separated list of valid product names", () => {
    process.env.PLAID_OPTIONAL_PRODUCTS_CSV = "liabilities,investments,auth";
    expect(parseOptionalProductsFromEnv()).toEqual([
      Products.Liabilities,
      Products.Investments,
      Products.Auth,
    ]);
  });

  it("trims whitespace around each entry", () => {
    process.env.PLAID_OPTIONAL_PRODUCTS_CSV = "  liabilities ,  investments  ";
    expect(parseOptionalProductsFromEnv()).toEqual([
      Products.Liabilities,
      Products.Investments,
    ]);
  });

  it("silently drops unknown product names", () => {
    process.env.PLAID_OPTIONAL_PRODUCTS_CSV =
      "liabilities,not_a_real_product,investments,bogus";
    expect(parseOptionalProductsFromEnv()).toEqual([
      Products.Liabilities,
      Products.Investments,
    ]);
  });

  it("returns [] when every entry is unknown (typo guard)", () => {
    process.env.PLAID_OPTIONAL_PRODUCTS_CSV = "liabilites,investmnts";
    expect(parseOptionalProductsFromEnv()).toEqual([]);
  });

  it("normalizes mixed-case names to lowercase", () => {
    process.env.PLAID_OPTIONAL_PRODUCTS_CSV = "Liabilities,INVESTMENTS,Auth";
    expect(parseOptionalProductsFromEnv()).toEqual([
      Products.Liabilities,
      Products.Investments,
      Products.Auth,
    ]);
  });

  it("ignores empty entries from leading/trailing/double commas", () => {
    process.env.PLAID_OPTIONAL_PRODUCTS_CSV = ",liabilities,,investments,";
    expect(parseOptionalProductsFromEnv()).toEqual([
      Products.Liabilities,
      Products.Investments,
    ]);
  });
});
