import { describe, it, expect } from "vitest";
import { shouldShowManualPickerOption } from "./chasePickerOptions";

describe("shouldShowManualPickerOption (#412)", () => {
  it("hides Manual entries when every transaction belongs to a Plaid account", () => {
    expect(
      shouldShowManualPickerOption({
        transactions: [
          { plaidAccountId: "acct-chase-1" },
          { plaidAccountId: "acct-chase-2" },
        ],
        currentlySelected: false,
      }),
    ).toBe(false);
  });

  it("hides Manual entries on an empty transaction list", () => {
    expect(
      shouldShowManualPickerOption({
        transactions: [],
        currentlySelected: false,
      }),
    ).toBe(false);
  });

  it("shows Manual entries when at least one transaction has no plaidAccountId", () => {
    expect(
      shouldShowManualPickerOption({
        transactions: [
          { plaidAccountId: "acct-chase-1" },
          { plaidAccountId: null },
        ],
        currentlySelected: false,
      }),
    ).toBe(true);
  });

  it("treats undefined plaidAccountId as a manual row", () => {
    expect(
      shouldShowManualPickerOption({
        transactions: [{}],
        currentlySelected: false,
      }),
    ).toBe(true);
  });

  it("keeps Manual entries visible when currently selected, even with no manual rows", () => {
    expect(
      shouldShowManualPickerOption({
        transactions: [{ plaidAccountId: "acct-chase-1" }],
        currentlySelected: true,
      }),
    ).toBe(true);
  });
});
