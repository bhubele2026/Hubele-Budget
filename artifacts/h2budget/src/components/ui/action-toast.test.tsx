import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { Toaster } from "./toaster";
import { ToastAction } from "./toast";
import { toast } from "@/hooks/use-toast";
import { toastWithActions } from "./action-toast";

afterEach(cleanup);

describe("toastWithActions — two actions on one toast (C0)", () => {
  it("shows both buttons side by side and each runs its own handler", () => {
    const undo = vi.fn();
    const applyAll = vi.fn();
    render(<Toaster />);
    act(() => {
      toastWithActions({
        title: "Filed under Groceries",
        actions: [
          { label: "Undo", onClick: undo, "data-testid": "toast-undo" },
          { label: "Apply to 12 similar", onClick: applyAll, "data-testid": "toast-apply" },
        ],
      });
    });
    const row = screen.getByTestId("toast-actions");
    const buttons = Array.from(row.querySelectorAll("button"));
    expect(buttons.map((b) => b.textContent)).toEqual(["Undo", "Apply to 12 similar"]);
    fireEvent.click(screen.getByTestId("toast-apply"));
    expect(applyAll).toHaveBeenCalledTimes(1);
    expect(undo).not.toHaveBeenCalled();
  });

  it("one action renders exactly as before — no wrapper row", () => {
    render(<Toaster />);
    act(() => {
      toast({ title: "Saved", action: <ToastAction altText="Undo">Undo</ToastAction> });
    });
    expect(screen.getByText("Undo")).toBeTruthy();
    expect(screen.queryByTestId("toast-actions")).toBeNull();
  });

  it("a single-button call through the helper also has no wrapper row", () => {
    const undo = vi.fn();
    render(<Toaster />);
    act(() => {
      toastWithActions({ title: "Moved", actions: [{ label: "Undo", onClick: undo }] });
    });
    fireEvent.click(screen.getByText("Undo"));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("toast-actions")).toBeNull();
  });
});
