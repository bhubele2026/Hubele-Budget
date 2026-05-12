import { describe, it, expect } from "vitest";
import {
  isHeuristicTransfer,
  TRANSFER_DESC_PATTERNS,
  TRANSFER_PFC_PRIMARY,
} from "@workspace/api-zod";

describe("(#642) isHeuristicTransfer", () => {
  it("matches the canonical 'Online Transfer to SAV …9128' description that triggered #642", () => {
    expect(
      isHeuristicTransfer("Online Transfer to SAV ...9128"),
    ).toBe(true);
  });

  it("matches the documented description fragments case-insensitively", () => {
    for (const frag of TRANSFER_DESC_PATTERNS) {
      const desc = `prefix ${frag} suffix`;
      expect(isHeuristicTransfer(desc)).toBe(true);
      expect(isHeuristicTransfer(desc.toLowerCase())).toBe(true);
      expect(isHeuristicTransfer(desc.toUpperCase())).toBe(true);
    }
  });

  it("matches Plaid PFC primaries that always indicate a transfer / card payment", () => {
    for (const pfc of TRANSFER_PFC_PRIMARY) {
      expect(isHeuristicTransfer("Some merchant", pfc)).toBe(true);
    }
  });

  it("does NOT match a plain merchant whose name happens to contain 'pay'", () => {
    expect(isHeuristicTransfer("PAYLESS SHOES #4521")).toBe(false);
  });

  it("returns false for null / empty descriptions with no PFC", () => {
    expect(isHeuristicTransfer(null)).toBe(false);
    expect(isHeuristicTransfer(undefined)).toBe(false);
    expect(isHeuristicTransfer("")).toBe(false);
  });
});
