import { lazy, Suspense, useRef, useState } from "react";
import type { WaysBack } from "@workspace/api-client-react";
import { ActionCard } from "@/kit/ActionCard";
import { Note } from "@/kit/Note";
import { Section } from "@/kit/Section";
import { SkeletonLine } from "@/kit/Skeleton";
import { type Attention } from "./attention";

// (V4) The sheet loads on first press (warmed on hover/focus), never on the open path.
const WaysBackSheet = lazy(() => import("./WaysBackSheet"));

/** ONE THING — steps through the matches with "Next"; nothing is saved. */
export function OneThing({
  items,
  loading,
  sampleWaysBack,
}: {
  items: Attention[];
  loading: boolean;
  /** The public sample page hands the sheet made-up figures (no network). */
  sampleWaysBack?: WaysBack;
}) {
  const [at, setAt] = useState(0);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const returnRef = useRef<HTMLElement | null>(null);
  const item = items[at % items.length];
  return (
    <Section label="One thing" data-testid="section-one-thing">
      {loading ? (
        <SkeletonLine className="w-56" />
      ) : !item ? (
        // Nothing was read, so nothing can be said: never "Nothing needs you".
        <Note kind="empty">Can't check until the numbers load.</Note>
      ) : (
        <ActionCard
          data-testid="action-card"
          title={item.title}
          detail={item.detail}
          action={item.action}
          onAction={
            item.wayBack
              ? {
                  label: "Pick a way back",
                  onClick: (e) => {
                    returnRef.current = e.currentTarget;
                    setMounted(true);
                    setOpen(true);
                  },
                }
              : undefined
          }
          done={item.kind === "nothing"}
          onNext={items.length > 1 ? () => setAt((n) => (n + 1) % items.length) : undefined}
        />
      )}
      {mounted && (
        <Suspense fallback={null}>
          <WaysBackSheet open={open} onOpenChange={setOpen} returnFocusRef={returnRef} sample={sampleWaysBack} />
        </Suspense>
      )}
    </Section>
  );
}
