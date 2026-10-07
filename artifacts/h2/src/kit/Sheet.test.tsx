import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sheet } from "./Sheet";
import { Button } from "./Button";

afterEach(cleanup);

describe("Sheet — Escape closes it and returns focus to what opened it", () => {
  it("opens from its trigger, is a named dialog, and hands focus back on Escape", async () => {
    const user = userEvent.setup();
    render(
      <Sheet title="Electric bill" description="A sample sheet." trigger={<Button>Open</Button>}>
        <p>Inside</p>
      </Sheet>,
    );
    const trigger = screen.getByRole("button", { name: "Open" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Electric bill" });
    expect(dialog.textContent).toContain("Inside");
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("the close button has a name and closes it too", async () => {
    const user = userEvent.setup();
    render(
      <Sheet title="Details" trigger={<Button>Open</Button>}>
        <p>Inside</p>
      </Sheet>,
    );
    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
