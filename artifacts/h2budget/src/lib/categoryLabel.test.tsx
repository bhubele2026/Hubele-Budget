import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { categoryCell, categoryLabel } from "./categoryLabel";
import { CategoryPicker } from "@/components/category-picker";
import { TxnTable, type TxnRow } from "@/components/next/TxnTable";

/**
 * (Q4) A category word has four honest states: none, still loading (blank),
 * found, and deleted. "Unknown" and "Uncategorized" are never drawn for a row
 * that has a category while the list loads.
 */
const cats = [{ id: "c1", name: "Groceries" }];

describe("categoryLabel", () => {
  it("no id is Uncategorized", () => {
    expect(categoryLabel(null, cats)).toBe("Uncategorized");
    expect(categoryLabel(undefined, undefined)).toBe("Uncategorized");
  });
  it("the list still loading is blank, never 'Unknown' or 'Uncategorized'", () => {
    expect(categoryLabel("c1", undefined)).toBe("");
  });
  it("found is its name; loaded but missing is 'Deleted category'", () => {
    expect(categoryLabel("c1", cats)).toBe("Groceries");
    expect(categoryLabel("gone", cats)).toBe("Deleted category");
  });
  it("categoryCell is the same for a prebuilt map (null = none)", () => {
    const names = new Map([["c1", "Groceries"]]);
    expect(categoryCell(null, names)).toBeNull();
    expect(categoryCell("c1", undefined)).toBe("");
    expect(categoryCell("c1", names)).toBe("Groceries");
    expect(categoryCell("gone", names)).toBe("Deleted category");
  });
});

afterEach(() => cleanup());

describe("CategoryPicker trigger", () => {
  const trigger = () => screen.getByRole("combobox");
  it("list loading: a skeleton, no 'Unknown'", () => {
    render(<CategoryPicker value="c1" categories={undefined} onChange={() => {}} />);
    expect(screen.getByTestId("category-picker-loading")).toBeTruthy();
    expect(trigger().textContent).toBe("");
    expect(trigger().getAttribute("aria-label")).toBe("Category");
  });
  it("loaded: the name; missing: 'Deleted category'; none: 'Uncategorized'", () => {
    const { rerender } = render(<CategoryPicker value="c1" categories={cats} onChange={() => {}} />);
    expect(trigger().textContent).toBe("Groceries");
    rerender(<CategoryPicker value="gone" categories={cats} onChange={() => {}} />);
    expect(trigger().textContent).toBe("Deleted category");
    rerender(<CategoryPicker value={null} categories={cats} onChange={() => {}} />);
    expect(trigger().textContent).toBe("Uncategorized");
    rerender(<CategoryPicker value={null} categories={undefined} onChange={() => {}} />);
    expect(trigger().textContent).toBe("Uncategorized");
  });
});

describe("TxnTable category cell", () => {
  const identity = { label: "Checking", accent: "checking", mask4: null, kind: "bank" } as never;
  const base: Omit<TxnRow, "category"> = { id: "t1", date: "2026-10-12", description: "SHOP", amount: -5, identity, pending: false };
  it("'' (list loading) is a skeleton; null is Uncategorized; a name is the name", () => {
    const { rerender } = render(<TxnTable rows={[{ ...base, category: "" }]} layout="list" />);
    expect(screen.getByTestId("txn-category-loading")).toBeTruthy();
    expect(screen.queryByText("Uncategorized")).toBeNull();
    rerender(<TxnTable rows={[{ ...base, category: null }]} layout="list" />);
    expect(screen.getByText("Uncategorized")).toBeTruthy();
    rerender(<TxnTable rows={[{ ...base, category: "Groceries" }]} layout="list" />);
    expect(screen.getByText("Groceries")).toBeTruthy();
  });
});
