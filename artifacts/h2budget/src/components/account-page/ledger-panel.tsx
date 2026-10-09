import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { Panel } from "@/components/next";
import type { AccountAccentName } from "@/lib/accountIdentity";

/**
 * ⭐ THE ACCOUNT LEDGER AS A PANEL (C9) — one frame for the Chase and Amex
 * registers, standalone and embedded alike.
 *
 * A full-width panel (`span-12`) whose body opens with the ledger's PINNED
 * PANE: the review controls stick to the top of `<main>` while the reader
 * works down the rows, and the page publishes the pane's height as
 * `--page-sticky-top` (`usePaneHeight`) so the bulk bar and the day heads
 * stick flush beneath it.
 *
 * ⚠️ STICKY-SAFE, OR NOTHING STICKS. `.panel` is `overflow: hidden`, which
 * makes it a scroll container; a sticky row inside one sticks to the panel —
 * which never scrolls — instead of to `<main>`. The panel is
 * `variant="sticky-safe"` (`overflow: clip`): it clips its corners the same
 * way but is not a scroll container. `flush` lets the pane and the day heads
 * run edge to edge; `static` drops the hover lift (a ledger is not a link).
 *
 * ⚠️ NO ENTRANCE TRANSFORM HERE. A `transform` on an ancestor gives a
 * `position: fixed` descendant a new containing block; the ledger hosts the
 * sticky stack and its dialogs, so it is not given `tile-in`.
 */
export function LedgerPanel({
  title,
  sub,
  accent,
  actions,
  pane,
  paneRef,
  children,
  "data-testid": testId = "ledger-panel",
}: {
  title: string;
  sub?: string;
  accent?: AccountAccentName;
  actions?: ReactNode;
  /** The pinned controls (review count, selection, hide reviewed …). */
  pane: ReactNode;
  /** Measured by the page (`usePaneHeight`) for `--page-sticky-top`. */
  paneRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <Panel
      title={title}
      sub={sub}
      accent={accent}
      actions={actions}
      span={12}
      variant={["sticky-safe", "flush", "static"]}
      data-testid={testId}
    >
      <div
        ref={paneRef}
        data-testid="ledger-pane"
        className="sticky top-0 z-30 border-b border-brand-line bg-platinum-0 px-4 py-2"
      >
        {pane}
      </div>
      <div data-testid="ledger-body" className="pb-2">
        {children}
      </div>
    </Panel>
  );
}

/**
 * The height of a pinned pane, live (ResizeObserver): what the page sets as
 * `--page-sticky-top`. `deps` re-attaches the observer when the pane mounts
 * late (after a cold skeleton).
 */
export function usePaneHeight(
  ref: RefObject<HTMLElement | null>,
  deps: readonly unknown[] = [],
): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setH(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return h;
}
