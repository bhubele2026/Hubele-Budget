import { lazy, Suspense, useState } from "react";
import { btn } from "@/ui";
import { cn } from "@/lib/utils";

// The sheet (and the features hooks it needs) load on first press only.
const WaysBackSheet = lazy(() => import("./WaysBackSheet"));

/** "Pick a way back" — the over-limit offer on Allowances and the dashboard briefing. */
export function WaysBackLauncher({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [ever, setEver] = useState(false);
  return (
    <>
      <button
        type="button"
        className={cn(btn, className)}
        onClick={() => {
          setEver(true);
          setOpen(true);
        }}
        data-testid="ways-back-open"
      >
        Pick a way back
      </button>
      {ever ? (
        <Suspense fallback={null}>
          <WaysBackSheet open={open} onOpenChange={setOpen} />
        </Suspense>
      ) : null}
    </>
  );
}
