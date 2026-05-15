import { describe, it, expect } from "vitest";
import {
  isHeuristicTransfer,
  TRANSFER_DESC_PATTERNS,
  TRANSFER_PFC_PRIMARY,
} from "@workspace/api-zod";

describe("(#666) isHeuristicTransfer is disabled", () => {
  it("PFC and description pattern lists are empty", () => {
    expect(TRANSFER_DESC_PATTERNS.length).toBe(0);
    expect(TRANSFER_PFC_PRIMARY.size).toBe(0);
  });

  it("returns false for descriptions that previously triggered auto-flagging", () => {
    expect(isHeuristicTransfer("Online Transfer to SAV ...9128")).toBe(false);
    expect(isHeuristicTransfer("payment - thank you")).toBe(false);
    expect(isHeuristicTransfer("ODP TRANSFER FROM SAVINGS")).toBe(false);
    expect(isHeuristicTransfer("AUTOPAY PAYMENT")).toBe(false);
  });

  it("returns false for Plaid PFC primaries that previously auto-flagged", () => {
    expect(isHeuristicTransfer("Some merchant", "TRANSFER_IN")).toBe(false);
    expect(isHeuristicTransfer("Some merchant", "TRANSFER_OUT")).toBe(false);
    expect(isHeuristicTransfer("Some merchant", "LOAN_PAYMENTS")).toBe(false);
  });

  it("returns false for plain merchants and null/empty inputs", () => {
    expect(isHeuristicTransfer("PAYLESS SHOES #4521")).toBe(false);
    expect(isHeuristicTransfer(null)).toBe(false);
    expect(isHeuristicTransfer(undefined)).toBe(false);
    expect(isHeuristicTransfer("")).toBe(false);
  });
});
