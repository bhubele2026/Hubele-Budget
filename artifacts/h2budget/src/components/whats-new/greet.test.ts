import { describe, it, expect, afterEach, vi } from "vitest";
import { greetBlocker } from "./greet";

/** (WN) What holds the greeting back — each reason on its own. */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const ok = () => greetBlocker({ path: "/home", version: "ok" });

describe("greetBlocker", () => {
  it("nothing in the way: null", () => {
    expect(ok()).toBeNull();
  });

  it("a hidden tab", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    expect(ok()).toBe("hidden");
  });

  it("an open dialog, drawer, menu, list or Clerk's popover", () => {
    for (const html of [
      '<div role="dialog" data-state="open"></div>',
      '<div role="alertdialog"></div>',
      '<div role="menu"></div>',
      '<div role="listbox"></div>',
      '<div class="cl-userButtonPopoverCard"></div>',
    ]) {
      document.body.innerHTML = html;
      expect(ok(), html).toBe("overlay");
    }
    // A closed Radix dialog left in the tree does not hold it.
    document.body.innerHTML = '<div role="dialog" data-state="closed"></div>';
    expect(ok()).toBeNull();
  });

  it("Plaid Link only while its frame is showing", () => {
    document.body.innerHTML = '<iframe id="plaid-link-iframe-1"></iframe>';
    expect(ok()).toBeNull(); // created, not open (no size)
    const frame = document.querySelector("iframe")!;
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({ width: 400, height: 600 } as DOMRect);
    expect(ok()).toBe("plaid");
  });

  it("a focused field", () => {
    document.body.innerHTML = "<textarea></textarea>";
    document.querySelector("textarea")!.focus();
    expect(ok()).toBe("typing");
  });

  it("the bank's sign-in return page", () => {
    expect(greetBlocker({ path: "/plaid-oauth", version: "ok" })).toBe("route");
  });

  it("a version check still out, a reload coming, or the new-version banner", () => {
    expect(greetBlocker({ path: "/home", version: "waiting" })).toBe("version");
    expect(greetBlocker({ path: "/home", version: "outdated" })).toBe("version");
    document.body.innerHTML = '<div data-testid="version-update-banner"></div>';
    expect(ok()).toBe("version");
  });
});
