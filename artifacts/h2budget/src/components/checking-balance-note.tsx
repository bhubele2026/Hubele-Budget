import { lazy, Suspense, useState } from "react";
import { calculatedLine, type ReadingLike, type SinceLike } from "@/lib/checkingWords";
import { CheckingBalance, type CheckingBalanceSize } from "@/components/checking-balance";

// The explanation is its own chunk and is mounted on the first press of Details (it draws nothing until opened).
const BankBalanceWhy = lazy(() => import("@/components/bank-balance-why").then((m) => ({ default: m.BankBalanceWhy })));

const DETAILS_BTN =
  "press rounded-control font-semibold text-brand-navy underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40";

/**
 * ⭐ (C1) "Details" — the existing "Why this number?" popover (BankBalanceWhy), mounted on the first press
 * (its own chunk; nothing is read or drawn until then), then open. One button, the same on every surface.
 */
export function BalanceDetails({ testid = "checking-balance-details", onReviewDifference }: { testid?: string; onReviewDifference?: () => void }) {
  const [opened, setOpened] = useState(false);
  const button = (
    <button type="button" className={DETAILS_BTN} data-testid={testid} onClick={opened ? undefined : () => setOpened(true)}>
      Details
    </button>
  );
  return opened ? (
    <Suspense fallback={button}>
      <BankBalanceWhy defaultOpen trigger={button} onReviewDifference={onReviewDifference} />
    </Suspense>
  ) : (
    button
  );
}

export interface CheckingNoteProps {
  reading: ReadingLike | null | undefined;
  since: SinceLike | null | undefined;
  /** "Earlier reading (…) — updating…" replaces the calculated line. */
  older?: string | null;
  /** The Details popover; `false` hides it (an account the balance does not roll on). */
  details?: false | { onReviewDifference?: () => void };
  /** Keep a surface's own test ids (line / details). */
  testids?: { line?: string; details?: string };
}

/** The calculated line and the one Details button. */
export function CheckingBalanceNote({ reading, since, older, details = {}, testids = {} }: CheckingNoteProps) {
  return (
    <>
      <div className="mt-1 text-micro text-neutral-600" data-testid={testids.line ?? "checking-balance-line"}>
        {older ?? calculatedLine(reading, since)}
      </div>
      {details !== false ? (
        <div className="relative z-10 mt-1 text-micro">
          <BalanceDetails testid={testids.details ?? "checking-balance-details"} onReviewDifference={details.onReviewDifference} />
        </div>
      ) : null}
    </>
  );
}

/** The whole block for a page: face + note, both in the page's chunk. */
export function CheckingBalanceFull({
  figure,
  size,
  className,
  testids = {},
  status,
  ...note
}: CheckingNoteProps & {
  figure: string | number | null | undefined;
  size: CheckingBalanceSize;
  className?: string;
  testids?: { figure?: string; line?: string; details?: string };
  /** The spine has not answered ("Loading…") or failed ("Couldn't load"): the face, and this one line instead of a note that would claim a reading. */
  status?: string;
}) {
  return (
    <CheckingBalance
      figure={figure}
      older={note.older}
      size={size}
      className={className}
      figureTestId={testids.figure}
      note={
        status ? (
          <div className="mt-1 text-micro text-neutral-600" data-testid={testids.line ?? "checking-balance-line"}>
            {status}
          </div>
        ) : (
          <CheckingBalanceNote {...note} testids={testids} />
        )
      }
    />
  );
}

export default CheckingBalanceNote;
