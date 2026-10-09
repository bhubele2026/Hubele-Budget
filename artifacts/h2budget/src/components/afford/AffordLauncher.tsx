import { lazy, Suspense, useState } from "react";
import { btnSecondarySm } from "@/ui";
import { cn } from "@/lib/utils";

// The sheet (and the money hooks it pulls from the features module) loads only
// when the launcher is first opened, so the pages that carry it stay light.
const AffordSheet = lazy(() => import("./AffordSheet"));

/** "Can we afford something?" — the launcher the Budget, Allowances and dashboard pages carry. */
export function AffordLauncher({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [ever, setEver] = useState(false);
  return (
    <>
      <button
        type="button"
        className={cn(btnSecondarySm, className)}
        onClick={() => {
          setEver(true);
          setOpen(true);
        }}
        data-testid="afford-open"
      >
        Can we afford something?
      </button>
      {ever ? (
        <Suspense fallback={null}>
          <AffordSheet open={open} onOpenChange={setOpen} />
        </Suspense>
      ) : null}
    </>
  );
}
