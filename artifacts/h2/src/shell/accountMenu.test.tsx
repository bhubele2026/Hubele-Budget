import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

const clerk = vi.hoisted(() => ({ signOut: vi.fn(), openUserProfile: vi.fn() }));
vi.mock("@clerk/react", () => ({
  useClerk: () => clerk,
  useUser: () => ({ user: { firstName: "Sam", primaryEmailAddress: { emailAddress: "sam@example.com" } } }),
}));
vi.mock("@/lib/routePrefetch", () => ({ prefetchRoute: () => {} }));

import { AccountMenu } from "./AccountMenu";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount() {
  const { hook, navigate } = memoryLocation({ path: "/" });
  render(
    <Router hook={hook}>
      <AccountMenu />
      <button type="button">after</button>
    </Router>,
  );
  return navigate;
}

describe("the account menu", () => {
  it("is closed until the avatar is pressed; the avatar is the first initial", async () => {
    const user = userEvent.setup();
    mount();
    const btn = screen.getByRole("button", { name: "Account menu" });
    expect(btn.textContent).toBe("S");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Household", "Recap", "AI cost", "Account", "Sign out"]);
    expect(screen.getByTestId("menu-household").getAttribute("href")).toBe("/household");
    expect(screen.getByTestId("menu-recap").getAttribute("href")).toBe("/recap");
    expect(screen.getByTestId("menu-ai").getAttribute("href")).toBe("/household/ai");
  });

  it("focus goes to the first item; arrows move; Escape closes and returns focus to the avatar", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Account menu" }));
    expect(document.activeElement).toBe(screen.getByTestId("menu-household"));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByTestId("menu-recap"));
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(screen.getByTestId("menu-signout"));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByTestId("menu-household"));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Account menu" }));
  });

  it("Sign out calls Clerk's signOut and closes; Account opens the profile", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Account menu" }));
    await user.click(screen.getByTestId("menu-account"));
    expect(clerk.openUserProfile).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Account menu" }));
    await user.click(screen.getByTestId("menu-signout"));
    expect(clerk.signOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a click outside closes it", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Account menu" }));
    await user.click(screen.getByRole("button", { name: "after" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("choosing Household navigates and closes the menu", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Account menu" }));
    await user.click(screen.getByTestId("menu-household"));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
