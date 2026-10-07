import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Figure } from "./Figure";

afterEach(cleanup);

describe("Figure", () => {
  it("shows whole dollars and carries the exact value to the cent", () => {
    const { container } = render(<Figure size="md" label="Bank balance" amount={12345.67} state="loaded" />);
    const data = container.querySelector("data")!;
    expect(data.textContent).toBe("$12,346");
    expect(data.getAttribute("value")).toBe("12345.67");
    expect(screen.getByText("Bank balance")).toBeTruthy();
  });

  it("a missing amount is a dash — never $0 — and says so to a screen reader", () => {
    const { container } = render(<Figure size="xl" label="Bank balance" amount={null} state="loaded" />);
    expect(container.textContent).toContain("—");
    expect(container.textContent).toContain("not available");
    expect(container.textContent).not.toMatch(/\$0/);
    expect(container.querySelector("data")).toBeNull();
  });

  it("a failed load with no amount is also a dash", () => {
    const { container } = render(<Figure size="md" label="Spent" amount={null} state="failed" />);
    expect(container.textContent).toContain("—");
  });

  it("cold (nothing received yet) is a skeleton shape with no text at all", () => {
    const { container } = render(<Figure size="xl" label="Bank balance" amount={null} state="cold" />);
    expect(container.textContent).toBe("Bank balance");
    expect(container.querySelector("[aria-hidden]")).toBeTruthy();
  });

  it("a real zero is $0", () => {
    const { container } = render(<Figure size="sm" label="Spent" amount={0} state="loaded" />);
    expect(container.querySelector("data")!.textContent).toBe("$0");
  });

  it("keeps the last figure while refreshing or after a failed refresh", () => {
    for (const state of ["refreshing", "refresh-failed"] as const) {
      const { container } = render(<Figure size="md" label="Spent" amount={412.4} state={state} />);
      expect(container.querySelector("data")!.textContent).toBe("$412");
      cleanup();
    }
  });

  it("sizes map to the type scale, and xl marks itself", () => {
    const { container } = render(<Figure size="xl" label="Bank" amount={1} state="loaded" />);
    expect(container.querySelector("[data-size='xl']")).toBeTruthy();
    expect(container.querySelector("data")!.className).toContain("type-figure-xl");
  });

  it("formats a percentage with a word after it", () => {
    const { container } = render(
      <Figure size="md" label="Toward debt-free" amount={41.3} state="loaded" format={(n) => `${Math.round(n)}%`} suffix="paid" />,
    );
    expect(container.querySelector("data")!.textContent).toBe("41%");
    expect(screen.getByText("paid")).toBeTruthy();
  });
});
