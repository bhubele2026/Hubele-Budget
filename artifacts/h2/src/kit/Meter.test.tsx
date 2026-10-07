import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Meter, meterStatus, meterWords, TIGHT_AT } from "./Meter";

afterEach(cleanup);

describe("meterStatus — on plan, tight, over", () => {
  it.each([
    [0, 600, "on"],
    [509.99, 600, "on"],
    [600 * TIGHT_AT, 600, "tight"],
    [600, 600, "tight"],
    [600.01, 600, "over"],
    [900, 600, "over"],
  ] as const)("%s of %s → %s", (spent, limit, status) => {
    expect(meterStatus(spent, limit)).toBe(status);
  });

  it("with no limit, any spending is over and none is on plan", () => {
    expect(meterStatus(0, 0)).toBe("on");
    expect(meterStatus(5, 0)).toBe("over");
  });
});

describe("meterWords — the status is always a word", () => {
  it("names each state", () => {
    expect(meterWords("on", 100, 600)).toBe("On plan");
    expect(meterWords("tight", 540, 600)).toBe("Tight");
    expect(meterWords("over", 655.2, 600)).toBe("Over by $55");
  });
  it("never says 'Over by $0'", () => {
    expect(meterWords("over", 600.4, 600)).toBe("Just over");
    expect(meterWords("over", 600.5, 600)).toBe("Over by $1");
  });
});

describe("Meter", () => {
  it("shows spent of limit with numbers first, the word, and an accessible meter", () => {
    const { container } = render(<Meter label="Spent so far" spent={412.4} limit={600} status="on" />);
    const values = Array.from(container.querySelectorAll("data"), (d) => [d.textContent, d.getAttribute("value")]);
    expect(values).toEqual([
      ["$412", "412.40"],
      ["$600", "600.00"],
    ]);
    expect(screen.getByTestId("meter-status").textContent).toBe("On plan");
    const meter = screen.getByRole("meter", { name: "Spent so far" });
    expect(meter.getAttribute("aria-valuetext")).toBe("$412 of $600, On plan");
    expect(meter.getAttribute("aria-valuemax")).toBe("600");
  });

  it("fills to the share spent, capped at full", () => {
    const { container, rerender } = render(<Meter label="w" spent={150} limit={600} status="on" />);
    expect(container.querySelector("[data-fill]")!.getAttribute("data-fill")).toBe("0.2500");
    rerender(<Meter label="w" spent={900} limit={600} status="over" />);
    expect(container.querySelector("[data-fill]")!.getAttribute("data-fill")).toBe("1.0000");
  });

  it("tight is hatched, not just coloured; over is clay", () => {
    const { container, rerender } = render(<Meter label="w" spent={540} limit={600} status="tight" />);
    expect(container.querySelector("[data-fill]")!.className).toContain("hatch");
    expect(screen.getByTestId("meter-status").textContent).toBe("Tight");
    rerender(<Meter label="w" spent={655.2} limit={600} status="over" />);
    expect(container.querySelector("[data-fill]")!.className).toContain("bg-clay");
    expect(screen.getByTestId("meter-status").textContent).toBe("Over by $55");
  });

  it("with no limit there is no bar and no status word, and the line says why", () => {
    const { container } = render(<Meter label="w" spent={120} limit={null} status="on" />);
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.queryByTestId("meter-status")).toBeNull();
    expect(container.textContent).toContain("No weekly limit set yet.");
    expect(container.querySelector("data")!.textContent).toBe("$120");
  });
});
