import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

/** (W1) /spending/week and /spending/month: a titled frame around Allowances, never a blank screen. */
vi.mock("./allowances", () => ({ default: () => <div data-testid="page-allowances" /> }));
import SpendingPeriodPage from "./spending-period";

afterEach(cleanup);

describe("This week / This month", () => {
  it.each([
    ["week", "This week"],
    ["month", "This month"],
  ] as const)("%s shows its title and the Allowances page", (view, title) => {
    render(<SpendingPeriodPage view={view} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(title);
    expect(screen.getByTestId("page-allowances")).toBeTruthy();
    expect(screen.getByTestId(`spending-${view}`)).toBeTruthy();
  });
});
