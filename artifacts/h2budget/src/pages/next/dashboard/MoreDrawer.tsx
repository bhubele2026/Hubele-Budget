import { lazy, Suspense, useState } from "react";
import { lazyWithPreload } from "@/lib/lazyWithPreload";
import { AffordLauncher } from "@/components/afford/AffordLauncher";
import { cn } from "@/lib/utils";
import Tiles from "./Tiles";
import { usePlaidItemsQ } from "./queries";
import { bankLines } from "./bankState";

/** The quiet control beside the morning text: Afford stays one tap away. */
const QUIET = "bg-transparent px-1 text-label font-semibold text-brand-navy ring-0 hover:bg-transparent hover:underline";
const QUIET_TEXT =
  "rounded-control text-label font-semibold text-brand-navy underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40";

/** The morning text preview (and the request behind it) load on first open only. */
const RecapPreview = lazyWithPreload(() => import("./RecapPreview"));
// (W4) The Amex tile's "Purchases this week": its own chunk.
const AmexWeekCharges = lazy(() => import("./AmexWeekCharges"));

/** Everything the home page showed before it became four numbers, with the same words. Mounts on first open. */
function MoreBody() {
  const items = usePlaidItemsQ();
  const [recapOpen, setRecapOpen] = useState(false);
  const banks = bankLines(items.data, Date.now());
  return (
    <div className="grid-12 mt-3" data-testid="dash-more-body">
      <Tiles
        weekCharges={
          <Suspense fallback={null}>
            <AmexWeekCharges />
          </Suspense>
        }
      />
      <div className="span-12">
        {banks.length ? (
          <ul className="flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-label text-neutral-600" data-testid="dash-bank-fresh">
            {banks.map((b) => (
              <li key={b.itemId} data-state={b.state}>
                <span
                  aria-hidden
                  className={cn("mr-1.5 inline-block size-1.5 rounded-full align-middle", b.state === "ok" ? "bg-acct-checking" : b.state === "stale" || b.state === "never" ? "bg-neutral-400" : "bg-bad")}
                />
                <span className="font-semibold text-neutral-700">{b.institution}</span>{" "}
                {/* Small alarm words take the rust (--color-bad-ink, 4.6–5.2:1); the dot keeps #e16d3e. */}
                <span className={cn(b.state === "reauth" || b.state === "failed" ? "font-semibold text-bad-ink" : undefined)}>· {b.words}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          <AffordLauncher className={QUIET} />
          <button
            type="button"
            className={QUIET_TEXT}
            aria-expanded={recapOpen}
            aria-controls="dash-recap"
            onClick={() => setRecapOpen((o) => !o)}
            data-testid="dash-recap-toggle"
          >
            {recapOpen ? "Hide morning text" : "Morning text"}
          </button>
          {recapOpen ? (
            <div id="dash-recap" className="mt-2">
              <Suspense fallback={<div className="skeleton h-12 w-full max-w-2xl rounded-control" aria-busy="true" />}>
                <RecapPreview />
              </Suspense>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * ⭐ "MORE" (Home is four numbers, 2026-11-11): a native disclosure, closed by
 * default, holding everything the home page used to open with — the six tiles
 * (`Tiles.tsx`, as it was), each bank's sync line, "Can we afford something?"
 * and the morning text. Nothing was dropped and no word changed; it is one tap
 * further away. Its own lazy chunk (the six tiles left the open path), and the
 * contents mount, and ask for what they read, only once it is first opened.
 */
export default function MoreDrawer() {
  const [ever, setEver] = useState(false);
  return (
    <details
      className="span-12"
      data-testid="dash-more"
      onToggle={(e) => {
        if (e.currentTarget.open) setEver(true);
      }}
    >
      <summary
        className="w-fit cursor-pointer rounded-control py-2.5 text-body font-semibold text-brand-navy underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40"
        data-testid="dash-more-summary"
      >
        More
      </summary>
      {ever ? <MoreBody /> : null}
    </details>
  );
}
