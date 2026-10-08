import type { ReactNode } from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { Dock } from "./Dock";
import { Masthead } from "./Masthead";

afterEach(cleanup);

function at(path: string, ui: ReactNode) {
  const { hook } = memoryLocation({ path });
  return render(<Router hook={hook}>{ui}</Router>);
}

describe("Dock — four destinations, one tab stop, arrow keys between them", () => {
  it("every item has an icon and a label, and all four are live links", () => {
    at("/", <Dock location="/" />);
    for (const key of ["today", "activity", "plan", "ask"]) {
      const item = screen.getByTestId(`dock-${key}`);
      expect(item.querySelector("svg")).toBeTruthy();
      expect(item.textContent).toMatch(/Today|Activity|Plan|Ask/);
    }
    expect(screen.getByTestId("dock-today").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("dock-activity").getAttribute("href")).toBe("/activity");
    expect(screen.getByTestId("dock-activity").getAttribute("aria-disabled")).toBeNull();
    expect(screen.getByTestId("dock-ask").getAttribute("href")).toBe("/ask");
    for (const key of ["today", "activity", "plan", "ask"]) {
      const item = screen.getByTestId(`dock-${key}`);
      expect(item.getAttribute("aria-disabled")).toBeNull();
      expect(item.textContent).not.toContain("soon");
    }
  });

  it("the Activity badge shows the count and is part of the link's name; zero shows nothing", () => {
    at("/", <Dock location="/" badges={{ activity: 4 }} />);
    expect(screen.getByTestId("dock-badge-activity").textContent).toBe("4");
    expect(screen.getByTestId("dock-activity").getAttribute("aria-label")).toBe("Activity, 4 to review");
    cleanup();
    at("/", <Dock location="/" badges={{ activity: 0 }} />);
    expect(screen.queryByTestId("dock-badge-activity")).toBeNull();
  });

  it("roving tabindex: exactly one item is in the tab order, the current one", () => {
    at("/", <Dock location="/" />);
    const tabbable = ["today", "activity", "plan", "ask"].filter(
      (k) => screen.getByTestId(`dock-${k}`).getAttribute("tabindex") === "0",
    );
    expect(tabbable).toEqual(["today"]);
  });

  it("ArrowRight / ArrowLeft / Home / End move focus, wrapping at the ends", async () => {
    const user = userEvent.setup();
    at("/", <Dock location="/" />);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId("dock-today"));
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByTestId("dock-activity"));
    expect(screen.getByTestId("dock-activity").getAttribute("tabindex")).toBe("0");
    expect(screen.getByTestId("dock-today").getAttribute("tabindex")).toBe("-1");
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(screen.getByTestId("dock-ask"));
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByTestId("dock-today"));
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(screen.getByTestId("dock-ask"));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(screen.getByTestId("dock-today"));
  });

  it("Tab leaves the dock after one stop", async () => {
    const user = userEvent.setup();
    at(
      "/",
      <>
        <Dock location="/" />
        <button type="button">after</button>
      </>,
    );
    await user.tab();
    await user.tab();
    expect(document.activeElement?.textContent).toBe("after");
  });
});

describe("Masthead", () => {
  it("marks Today current and every destination a link; none says soon", () => {
    at("/", <Masthead location="/" badges={{ activity: 3 }} />);
    expect(screen.getByTestId("masthead-today").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("masthead-activity").getAttribute("href")).toBe("/activity");
    expect(screen.getByTestId("masthead-badge-activity").textContent).toBe("3");
    for (const key of ["today", "activity", "plan", "ask"]) {
      const item = screen.getByTestId(`masthead-${key}`);
      expect(item.getAttribute("aria-disabled")).toBeNull();
      expect(item.getAttribute("href")).not.toBeNull();
      expect(item.textContent).not.toContain("soon");
    }
    expect(screen.getByTestId("masthead-ask").getAttribute("href")).toBe("/ask");
  });

  it("Plan is a live link, current on every Plan page", () => {
    at("/plan/debt", <Masthead location="/plan/debt" />);
    const plan = screen.getByTestId("masthead-plan");
    expect(plan.getAttribute("href")).toBe("/plan");
    expect(plan.getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("masthead-today").getAttribute("aria-current")).toBeNull();
  });

  it("off Today, nothing is marked current", () => {
    at("/design", <Masthead location="/design" />);
    expect(screen.getByTestId("masthead-today").getAttribute("aria-current")).toBeNull();
  });
});
