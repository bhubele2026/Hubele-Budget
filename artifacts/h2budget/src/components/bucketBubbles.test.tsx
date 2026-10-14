import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (rel: string) => readFileSync(resolve(process.cwd(), "src", rel), "utf8");
import { BucketBubbles } from "./bucket-bubbles";
import { BucketLegend } from "./bucket-legend";

/** (W3) The four marks are labelled controls: words, not two-letter glyphs. */
afterEach(() => cleanup());

const flags = { weekly: true, monthly: false, unplanned: false, reimbursable: false };

describe("BucketBubbles", () => {
  it("each mark has an accessible name (unchanged) and a one-line meaning as its tooltip", () => {
    render(<BucketBubbles flags={flags} onToggle={vi.fn()} />);
    const expected: Array<[string, string]> = [
      ["Weekly bucket", "Weekly: counts toward the weekly allowance"],
      ["Monthly bucket", "Monthly: counts toward the monthly allowance"],
      ["Unplanned bucket", "Unplanned: counts toward the unplanned allowance"],
      ["Reimbursable", "Reimbursable: someone will pay this back"],
    ];
    for (const [name, tip] of expected) {
      const b = screen.getByRole("button", { name });
      expect(b.getAttribute("title")).toBe(tip);
    }
  });

  it("aria-pressed follows the flag, and a click writes the opposite", () => {
    const onToggle = vi.fn();
    render(<BucketBubbles flags={flags} onToggle={onToggle} />);
    expect(screen.getByRole("button", { name: "Weekly bucket" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Monthly bucket" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Monthly bucket" }));
    expect(onToggle).toHaveBeenCalledWith("monthly", true);
    fireEvent.click(screen.getByRole("button", { name: "Weekly bucket" }));
    expect(onToggle).toHaveBeenCalledWith("weekly", false);
  });

  it("spells the words out (one letter on a phone and in the wide grid, with a legend), at 11px or more", () => {
    const { container } = render(<BucketBubbles flags={flags} onToggle={vi.fn()} />);
    for (const w of ["Weekly", "Monthly", "Unplanned", "Reimbursable", "W", "M", "U", "R"]) {
      expect(container.textContent).toContain(w);
    }
    const src = read("components/bucket-bubbles.tsx");
    expect(src).not.toMatch(/text-\[(\d|10)px\]/);
    expect(src).toContain("text-[11px]");
    // One letter where the bucket column is 6.75rem (the `@6xl` grid); the words between.
    expect(src).toContain("sm:hidden @6xl:inline");
    expect(src).toContain("hidden sm:inline @6xl:hidden");
  });

  it("the legend names the letters, once above the ledger", () => {
    render(<BucketLegend />);
    expect(screen.getByTestId("bucket-legend").textContent).toBe("W Weekly · M Monthly · U Unplanned · R Reimbursable");
  });
});

describe("Chase register — labels that say what they mean", () => {
  const page = read("pages/transactions.tsx");
  const strip = read("components/chase-insight-strip.tsx");
  it("no 'All reconciled' / 'Not planned' labels remain on the register", () => {
    expect(page).not.toMatch(/>\s*All reconciled\s*</);
    expect(page).not.toContain('label: "Not planned"');
    expect(page).toContain("Review inbox clear");
    expect(page).toContain('label: "Marked not in plan"');
  });
  it("the household strip says UN is an allowance flag, not a plan comparison", () => {
    expect(strip).toContain("Unplanned allowance (UN)");
    expect(strip).not.toContain('label="Unplanned spending"');
    expect(strip).not.toContain("Household spending this");
  });
});
