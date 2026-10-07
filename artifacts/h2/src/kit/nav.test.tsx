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
  it("every item has an icon and a label; only Today is live, the rest say soon", () => {
    at("/", <Dock location="/" />);
    for (const key of ["today", "activity", "plan", "ask"]) {
      const item = screen.getByTestId(`dock-${key}`);
      expect(item.querySelector("svg")).toBeTruthy();
      expect(item.textContent).toMatch(/Today|Activity|Plan|Ask/);
    }
    expect(screen.getByTestId("dock-today").getAttribute("aria-current")).toBe("page");
    for (const key of ["activity", "plan", "ask"]) {
      const item = screen.getByTestId(`dock-${key}`);
      expect(item.getAttribute("aria-disabled")).toBe("true");
      expect(item.textContent).toContain("soon");
    }
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
  it("marks Today current and the other destinations disabled, with 'soon'", () => {
    at("/", <Masthead location="/" />);
    expect(screen.getByTestId("masthead-today").getAttribute("aria-current")).toBe("page");
    for (const key of ["activity", "plan", "ask"]) {
      const item = screen.getByTestId(`masthead-${key}`);
      expect(item.getAttribute("aria-disabled")).toBe("true");
      expect(item.getAttribute("href")).toBeNull();
      expect(item.textContent).toContain("soon");
    }
  });

  it("off Today, nothing is marked current", () => {
    at("/design", <Masthead location="/design" />);
    expect(screen.getByTestId("masthead-today").getAttribute("aria-current")).toBeNull();
  });
});
