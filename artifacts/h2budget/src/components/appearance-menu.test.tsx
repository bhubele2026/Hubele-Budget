import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import React from "react";

const customFetch = vi.fn();
vi.mock("@workspace/api-client-react", () => ({ customFetch: (...a: unknown[]) => customFetch(...a) }));
const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ toast: (...a: unknown[]) => toast(...a) }));

import { APPEARANCE_CHOICES, APPEARANCE_HINT, AppearanceButton, AppearanceRow } from "./appearance-menu";
import { _resetThemeForTests, getAppearance } from "@/lib/theme";

/**
 * The Appearance control: the top bar's button, and the row of four used in the
 * phone drawer and in Settings. Words are pinned: they are what people read.
 */
describe("Appearance", () => {
  beforeEach(() => {
    window.localStorage.clear();
    customFetch.mockReset();
    toast.mockReset();
    _resetThemeForTests();
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    _resetThemeForTests();
  });

  it("offers exactly Auto · Light · Dark · Time of day, with the one hint line", () => {
    expect(APPEARANCE_CHOICES.map(([, name]) => name)).toEqual(["Auto", "Light", "Dark", "Time of day"]);
    expect(APPEARANCE_HINT).toBe("Auto follows this device. Time of day: dark 7 PM–7 AM.");
  });

  it("the top bar's button is named Appearance and opens a menu", () => {
    render(<AppearanceButton />);
    const b = screen.getByRole("button", { name: "Appearance" });
    expect(b.getAttribute("aria-haspopup")).toBe("menu");
    expect(b.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("the row is a radio group of four; the saved pick is the checked one; a press saves it", async () => {
    customFetch.mockResolvedValue({ appearance: "dark" });
    render(<AppearanceRow tone="page" />);
    const group = screen.getByRole("radiogroup", { name: "Appearance" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["Auto", "Light", "Dark", "Time of day"]);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false", "false"]);
    expect(screen.getByText(APPEARANCE_HINT)).toBeTruthy();
    fireEvent.click(within(group).getByRole("radio", { name: "Dark" }));
    expect(getAppearance()).toBe("dark");
    expect(within(group).getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true");
    expect(customFetch).toHaveBeenCalledTimes(1);
    expect((customFetch.mock.calls[0]![1] as RequestInit).body).toBe('{"appearance":"dark"}');
    await vi.waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("dark"));
    expect(toast).not.toHaveBeenCalled();
  });

  it("a refused save goes back and says so", async () => {
    customFetch.mockRejectedValue(new Error("500"));
    render(<AppearanceRow tone="chrome" />);
    fireEvent.click(screen.getByRole("radio", { name: "Time of day" }));
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith({ title: "Appearance was not saved. Try again." }));
    expect(getAppearance()).toBe("auto");
    expect(screen.getByRole("radio", { name: "Auto" }).getAttribute("aria-checked")).toBe("true");
  });
});
