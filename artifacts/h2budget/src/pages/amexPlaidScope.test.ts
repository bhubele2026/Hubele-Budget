import { describe, it, expect } from "vitest";
import type { PlaidItemDetail } from "@workspace/api-client-react";
import { relevantAmexPlaidItemIds } from "./amexPlaidScope";

function item(
  id: string,
  accounts: Array<{ accountId: string; rowId?: string }>,
): PlaidItemDetail {
  return {
    id,
    itemId: `ext-${id}`,
    institutionSlug: "test",
    accounts: accounts.map((a, i) => ({
      id: a.rowId ?? `${id}-row-${i}`,
      accountId: a.accountId,
    })),
  } as PlaidItemDetail;
}

describe("relevantAmexPlaidItemIds", () => {
  it("matches by Plaid external account_id (transaction-derived signal)", () => {
    const items = [
      item("chase", [{ accountId: "chase-checking-ext" }]),
      item("amex", [{ accountId: "amex-card-ext" }]),
    ];
    expect(relevantAmexPlaidItemIds(items, ["amex-card-ext"])).toEqual(["amex"]);
  });

  it("matches by internal plaid_accounts.id row id (debt-derived signal)", () => {
    const items = [
      item("chase", [{ accountId: "chase-checking-ext", rowId: "chase-row-1" }]),
      item("amex", [{ accountId: "amex-card-ext", rowId: "amex-row-1" }]),
    ];
    expect(
      relevantAmexPlaidItemIds(items, [], ["amex-row-1"]),
    ).toEqual(["amex"]);
  });

  it("dedupes when both signals point at the same item", () => {
    const items = [
      item("amex", [{ accountId: "amex-card-ext", rowId: "amex-row-1" }]),
    ];
    expect(
      relevantAmexPlaidItemIds(items, ["amex-card-ext"], ["amex-row-1"]),
    ).toEqual(["amex"]);
  });

  it("ignores items whose accounts do not match either signal", () => {
    const items = [
      item("chase", [{ accountId: "chase-checking-ext", rowId: "chase-row-1" }]),
    ];
    expect(
      relevantAmexPlaidItemIds(items, ["amex-card-ext"], ["amex-row-1"]),
    ).toEqual([]);
  });

  it("returns empty when neither signal carries any ids", () => {
    const items = [item("amex", [{ accountId: "amex-card-ext" }])];
    expect(relevantAmexPlaidItemIds(items, [], [])).toEqual([]);
  });

  it("dedupes when the same item owns multiple matched accounts", () => {
    const items = [
      item("amex", [
        { accountId: "amex-a-ext" },
        { accountId: "amex-b-ext" },
      ]),
    ];
    expect(
      relevantAmexPlaidItemIds(items, ["amex-a-ext", "amex-b-ext"]),
    ).toEqual(["amex"]);
  });

  it("handles null/undefined items gracefully", () => {
    expect(relevantAmexPlaidItemIds(null, ["amex-card-ext"])).toEqual([]);
    expect(relevantAmexPlaidItemIds(undefined, ["amex-card-ext"])).toEqual([]);
  });
});
