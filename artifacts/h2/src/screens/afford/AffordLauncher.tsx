import { lazy, Suspense, useRef, useState } from "react";
import { Button, type ButtonVariant } from "@/kit/Button";
import { importAfford } from "@/lib/routePrefetch";

// The sheet is its own chunk. Nothing of it is on the open path: the button
// below is all Today carries, and hover or focus warms the download.
const AffordSheet = lazy(importAfford);

/**
 * ⭐ "Can we afford something?" — the one control that opens the Afford sheet,
 * on Today (a quiet full-width button) and in Plan › The week (a link). The
 * sheet mounts on the first press and stays mounted, so closing it hands
 * focus back to this control.
 */
export function AffordLauncher({
  variant,
  className,
  "data-testid": testId = "afford-open",
}: {
  variant: ButtonVariant;
  className?: string;
  "data-testid"?: string;
}) {
  // null: never opened, so the sheet's chunk is not even requested by mounting.
  const [open, setOpen] = useState<boolean | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  const warm = () => void importAfford().catch(() => {});
  return (
    <>
      <Button
        ref={ref}
        variant={variant}
        className={className}
        onClick={() => setOpen(true)}
        onMouseEnter={warm}
        onFocus={warm}
        data-testid={testId}
      >
        Can we afford something?
      </Button>
      {open !== null && (
        <Suspense fallback={null}>
          <AffordSheet open={open} onOpenChange={setOpen} returnFocusRef={ref} />
        </Suspense>
      )}
    </>
  );
}
