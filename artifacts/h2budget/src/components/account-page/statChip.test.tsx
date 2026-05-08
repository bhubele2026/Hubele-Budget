import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { StatChip } from "./stat-chip";

afterEach(() => cleanup());

// (#464) Regression: the Charges / Payments & credits / Net change tiles
// on /amex and the Money in / Money out / Net change tiles on /chase must
// never silently render $0.00 when their underlying value is loading or
// missing. They share a single StatChip implementation, so covering the
// component's loading/missing/normal renderings here protects every tile.
const TILES: Array<{ label: string; testId: string; signed?: boolean }> = [
  { label: "Charges", testId: "stat-charges" },
  { label: "Payments & credits", testId: "stat-payments-credits" },
  { label: "Net change", testId: "stat-net-change", signed: true },
  { label: "Money in", testId: "stat-money-in" },
  { label: "Money out", testId: "stat-money-out" },
  { label: "Starting balance", testId: "stat-starting-balance" },
  { label: "Ending balance", testId: "stat-ending-balance" },
];

const textOf = (el: HTMLElement) => el.textContent ?? "";

describe("StatChip — never silently renders $0.00 when value is loading or missing", () => {
  for (const tile of TILES) {
    it(`renders a labeled "Loading…" affordance for ${tile.label} while loading`, () => {
      render(
        <StatChip
          label={tile.label}
          value={null}
          loading
          signed={tile.signed}
          testId={tile.testId}
        />,
      );
      const chip = screen.getByTestId(tile.testId);
      const text = textOf(chip);
      expect(text).toContain(tile.label);
      expect(text).toContain("Loading…");
      expect(text).not.toContain("$0.00");
      expect(screen.getByTestId(`${tile.testId}-loading`)).toBeTruthy();
    });

    it(`renders a labeled "Unavailable" affordance for ${tile.label} when value is missing`, () => {
      render(
        <StatChip
          label={tile.label}
          value={null}
          signed={tile.signed}
          testId={tile.testId}
          unavailableHint="No data yet."
        />,
      );
      const chip = screen.getByTestId(tile.testId);
      const text = textOf(chip);
      expect(text).toContain(tile.label);
      expect(text).toContain("Unavailable");
      expect(text).not.toContain("$0.00");
      expect(screen.getByTestId(`${tile.testId}-unavailable`)).toBeTruthy();
    });

    it(`renders the formatted currency for ${tile.label} when a real value is provided`, () => {
      render(
        <StatChip
          label={tile.label}
          value={12.34}
          signed={tile.signed}
          testId={tile.testId}
        />,
      );
      const chip = screen.getByTestId(tile.testId);
      const text = textOf(chip);
      expect(text).toContain(tile.label);
      expect(text).toContain(tile.signed ? "+$12.34" : "$12.34");
      expect(text).not.toContain("Loading…");
      expect(text).not.toContain("Unavailable");
    });
  }

  it("still renders a real $0.00 when the value is explicitly zero (not missing)", () => {
    render(<StatChip label="Charges" value={0} testId="stat-charges" />);
    const text = textOf(screen.getByTestId("stat-charges"));
    expect(text).toContain("$0.00");
    expect(text).not.toContain("Loading…");
    expect(text).not.toContain("Unavailable");
  });

  it("treats a non-finite value (NaN) as missing rather than rendering $NaN or $0.00", () => {
    render(
      <StatChip
        label="Net change"
        value={Number.NaN}
        testId="stat-net-change"
      />,
    );
    const text = textOf(screen.getByTestId("stat-net-change"));
    expect(text).toContain("Unavailable");
    expect(text).not.toContain("$0.00");
    expect(text).not.toContain("NaN");
  });
});
