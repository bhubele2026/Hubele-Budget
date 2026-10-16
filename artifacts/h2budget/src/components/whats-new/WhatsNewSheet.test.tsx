import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import type { WhatsNewUpdate } from "@workspace/avalanche-core/whatsNew";
import WhatsNewSheet, { type ReadReport } from "./WhatsNewSheet";

/**
 * (WN) The sheet: must-read (no X, Escape and a click outside do nothing, one
 * button that takes the focus without scrolling) vs history (X, Escape, Close),
 * the "New" chip only on unread notes, and the owner's read lines (never a
 * member's). Synthetic notes.
 */

const NOTES: WhatsNewUpdate[] = [
  { id: "2026-11-02", headline: "Newest note", items: [{ title: "First thing", body: "What it does." }, { title: "Second thing", body: "And this." }] },
  { id: "2026-10-20", headline: "Middle note", items: [{ title: "Middle thing", body: "Middle words." }] },
  { id: "2026-10-15", headline: "Oldest note", items: [{ title: "Old thing", body: "Old words." }] },
];

function renderSheet(p: Partial<Parameters<typeof WhatsNewSheet>[0]> = {}) {
  const onRead = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <WhatsNewSheet updates={NOTES} unread={[]} fromLink={false} owner={false} onRead={onRead} onClose={onClose} {...p} />,
  );
  return { ...view, onRead, onClose };
}

/** Radix registers its outside-press listener a tick after it opens. */
async function pressOutside() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });
  fireEvent.pointerDown(document.body);
}

afterEach(() => cleanup());

describe("must-read (something unread)", () => {
  it("has no X, and Escape or a press outside leave it open", async () => {
    const { onRead, onClose } = renderSheet({ unread: [NOTES[0]!] });
    const sheet = screen.getByTestId("whats-new-sheet");
    expect(sheet.getAttribute("data-must-read")).toBe("true");
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["I've read this"]);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await pressOutside();
    expect(screen.getByTestId("whats-new-sheet")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("whats-new-button"));
    expect(onRead).toHaveBeenCalledTimes(1);
  });

  it("shows only the unread notes in full when it greets; several say 'I've read these'", () => {
    renderSheet({ unread: [NOTES[0]!, NOTES[1]!] });
    expect(screen.getByTestId("whats-new-button").textContent).toBe("I've read these");
    expect(screen.getByText("Newest note")).toBeTruthy();
    expect(screen.getByText("Middle note")).toBeTruthy();
    expect(screen.queryByText("Oldest note")).toBeNull();
    expect(screen.queryByTestId("whats-new-earlier")).toBeNull();
    // The first headline is the dialog's title.
    expect(screen.getByRole("dialog", { name: "Newest note" })).toBeTruthy();
  });

  it("the button takes the focus without scrolling", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    try {
      renderSheet({ unread: [NOTES[0]!] });
      const btn = screen.getByTestId("whats-new-button");
      expect(document.activeElement).toBe(btn);
      const onButton = focus.mock.calls.filter((_, i) => focus.mock.contexts[i] === btn);
      expect(onButton.length).toBeGreaterThan(0);
      expect(onButton[0]![0]).toEqual({ preventScroll: true });
    } finally {
      focus.mockRestore();
    }
  });

  it("opened from the link while unread: must-read, with Earlier below", () => {
    renderSheet({ unread: [NOTES[0]!], fromLink: true });
    expect(screen.getByTestId("whats-new-button").textContent).toBe("I've read this");
    const earlier = screen.getByTestId("whats-new-earlier");
    expect(earlier.textContent).toContain("Middle note");
    expect(earlier.textContent).toContain("Oldest note");
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });
});

describe("history (nothing unread)", () => {
  it("the latest note in full, then Earlier; X, Escape, a press outside and Close all close it", async () => {
    const a = renderSheet({ fromLink: true });
    expect(a.getByTestId("whats-new-sheet").getAttribute("data-must-read")).toBe("false");
    expect(a.getByTestId("whats-new-button").textContent).toBe("Close");
    expect(a.getByTestId("whats-new-earlier").textContent).toContain("Middle note");
    fireEvent.click(a.getByTestId("whats-new-button"));
    expect(a.onClose).toHaveBeenCalledTimes(1);
    a.unmount();

    const b = renderSheet({ fromLink: true });
    // Two "Close" buttons: the X (sr-only label) and the footer's.
    const closes = b.getAllByRole("button", { name: "Close" });
    expect(closes).toHaveLength(2);
    fireEvent.click(closes.find((x) => x.getAttribute("data-testid") !== "whats-new-button")!);
    expect(b.onClose).toHaveBeenCalledTimes(1);
    b.unmount();

    const c = renderSheet({ fromLink: true });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(c.onClose).toHaveBeenCalledTimes(1);
    c.unmount();

    const d = renderSheet({ fromLink: true });
    await pressOutside();
    expect(d.onClose).toHaveBeenCalledTimes(1);
  });

  it("has no New chip when everything is read", () => {
    renderSheet({ fromLink: true });
    expect(screen.queryByTestId("whats-new-new")).toBeNull();
  });
});

describe("the New chip and the owner's read lines", () => {
  it("New sits only on unread notes", () => {
    renderSheet({ unread: [NOTES[1]!], fromLink: true });
    const chips = screen.getAllByTestId("whats-new-new");
    expect(chips).toHaveLength(1);
    expect(chips[0]!.closest("[data-whats-new-update]")!.getAttribute("data-whats-new-update")).toBe("2026-10-20");
  });

  const report: ReadReport = new Map([
    ["2026-11-02", [{ name: "Jen", readAt: "2026-11-02T18:00:00Z" }]],
    ["2026-10-20", [{ name: "Jen", readAt: null }]],
  ]);

  it("the owner sees 'Read by … on …' / 'Not read yet' under each note", () => {
    renderSheet({ owner: true, report, fromLink: true });
    const lines = screen.getAllByTestId("whats-new-readby").map((l) => l.textContent);
    expect(lines).toEqual(["Read by Jen on Monday, November 2", "Not read yet"]);
  });

  it("while the report loads, the line keeps its space; a failed report hides it", () => {
    const loading = renderSheet({ owner: true, report: undefined, fromLink: true });
    expect(loading.getAllByTestId("whats-new-readby-loading").length).toBe(3);
    loading.unmount();
    renderSheet({ owner: true, report: null, fromLink: true });
    expect(screen.queryByTestId("whats-new-readby-loading")).toBeNull();
    expect(screen.queryByTestId("whats-new-readby")).toBeNull();
  });

  it("a member never sees read lines", () => {
    renderSheet({ owner: false, report, fromLink: true });
    expect(screen.queryByTestId("whats-new-readby")).toBeNull();
    expect(screen.queryByText(/Read by/)).toBeNull();
    expect(screen.queryByText(/Not read yet/)).toBeNull();
  });
});
