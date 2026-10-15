import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { Transaction } from "@workspace/api-client-react";

/**
 * (Q6a) The quiet per-row menu: ‹1d, move-to-a-day, edit and delete behind one
 * keyboard-reachable button. Synthetic row.
 */
import { RowMenu } from "./row-menu";

afterEach(() => cleanup());

const tx = { id: "t1", occurredOn: "2026-09-15", description: "CORNER CAFE" } as unknown as Transaction;

function open() {
  const btn = screen.getByRole("button", { name: "More actions for Corner Cafe" });
  btn.focus();
  fireEvent.keyDown(btn, { key: "Enter" });
  return btn;
}

describe("RowMenu", () => {
  it("is named for the merchant, opens on Enter, arrows move, Enter chooses", async () => {
    const onMove = vi.fn();
    const onEdit = vi.fn();
    render(<RowMenu tx={tx} merchant="Corner Cafe" onMove={onMove} onEdit={onEdit} onDelete={vi.fn()} />);
    open();
    const menu = await screen.findByRole("menu");
    expect(menu).toBeTruthy();
    const items = screen.getAllByRole("menuitem").map((i) => i.textContent?.trim());
    expect(items).toEqual(["Move back 1 day", "Move to a day…", "Edit", "Delete"]);
    // ArrowDown moves focus through the items; Enter on the first runs its handler.
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    const first = screen.getByTestId("button-bump-date-back-t1");
    await waitFor(() => expect(document.activeElement).toBe(first));
    fireEvent.keyDown(first, { key: "Enter" });
    expect(onMove).toHaveBeenCalledWith("2026-09-14");
  });

  it("Escape closes the menu and returns focus to the button", async () => {
    render(<RowMenu tx={tx} merchant="Corner Cafe" onMove={vi.fn()} />);
    const btn = open();
    const menu = await screen.findByRole("menu");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(btn);
  });

  it("a pending row (no onMove) keeps edit and delete only; with nothing to offer it renders nothing", async () => {
    render(<RowMenu tx={tx} merchant="Corner Cafe" onEdit={vi.fn()} />);
    open();
    await screen.findByRole("menu");
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent?.trim())).toEqual(["Edit"]);
    cleanup();
    const { container } = render(<RowMenu tx={tx} merchant="Corner Cafe" />);
    expect(container.querySelector("button")).toBeNull();
  });

  it("Move to a day… saves the chosen day through onMove", async () => {
    const onMove = vi.fn(async () => true);
    render(<RowMenu tx={tx} merchant="Corner Cafe" onMove={onMove} />);
    open();
    await screen.findByRole("menu");
    fireEvent.keyDown(screen.getByTestId("button-inline-date-t1"), { key: "Enter" });
    const input = (await screen.findByTestId("input-inline-date-t1")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2026-09-10" } });
    fireEvent.click(screen.getByTestId("button-save-inline-date-t1"));
    await waitFor(() => expect(onMove).toHaveBeenCalledWith("2026-09-10"));
  });
});
