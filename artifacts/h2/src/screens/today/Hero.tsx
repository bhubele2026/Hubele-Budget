import { lazy, Suspense, useRef, useState } from "react";
import type { MoneyPosition, Spine } from "@workspace/api-client-react";
import { Figure } from "@/kit/Figure";
import { shortDateOfInstant, weekdayDate } from "@/lib/dates";
import { fmtMoney, toAmount } from "@/lib/money";
import type { DataState } from "@/lib/queryState";
import type { Read } from "@/data/todayData";

// The sheet carries Radix Dialog; it loads the first time the hero is opened
// (and is prefetched below on hover/focus), never on the open path.
const importAssumptions = () => import("./AssumptionsSheet");
const AssumptionsSheet = lazy(importAssumptions);

/** Why the hero has no figure, in one short line. */
export function noFigureReason(p: Spine["position"] | undefined): string {
  if (p?.degraded) return "Waiting on a fresh bank balance.";
  if (p?.horizonKind === "week_end") return "No payday on file yet.";
  return "Not enough on file to work this out yet.";
}

/**
 * ⭐ FREE UNTIL PAYDAY — the one figure-xl. It is the spine's
 * `position.safeToSpendNow`, read, never worked out here. The hero is a
 * button: it opens the assumptions sheet that shows how the figure is made.
 *
 * "estimated" sits right beside the figure when any bill in the window is an
 * estimate; "from bank data as of <date>" when the bank is out of date.
 */
export function Hero({
  spine,
  state,
  position,
}: {
  spine: Spine | undefined;
  state: DataState;
  position: Read<MoneyPosition>;
}) {
  const p = spine?.position;
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  const amount = toAmount(p?.safeToSpendNow);
  const weekEnd = p?.horizonKind === "week_end";
  const label = weekEnd ? "Free until Saturday" : "Free until payday";
  const committed = toAmount(position.data?.committedUntilPayday);

  const lines: string[] = [];
  if (amount == null && spine) lines.push(noFigureReason(p));
  if (p) {
    if (weekEnd) lines.push("No payday on file in the next 45 days");
    else if (p.paydayDate) {
      lines.push(
        `Payday ${weekdayDate(p.paydayDate)}${committed != null ? ` · ${fmtMoney(committed)} in bills before then` : ""}`,
      );
    }
  }
  if (p?.degraded && spine?.bank.asOfDate) {
    lines.push(`from bank data as of ${shortDateOfInstant(spine.bank.asOfDate)}`);
  }

  const spoken = amount == null ? "not available" : fmtMoney(amount);
  return (
    <div className="pb-8">
      <button
        ref={ref}
        type="button"
        className="block w-full cursor-pointer rounded-1 text-left"
        aria-haspopup="dialog"
        aria-label={`${label}: ${spoken}${p?.confidence === "estimated" && amount != null ? ", estimated" : ""}. How this is worked out.`}
        onMouseEnter={() => void importAssumptions()}
        onFocus={() => void importAssumptions()}
        onClick={() => {
          setMounted(true);
          setOpen(true);
        }}
        data-testid="hero"
      >
        <Figure
          size="xl"
          label={label}
          amount={amount}
          state={state}
          suffix={p?.confidence === "estimated" && amount != null ? "estimated" : undefined}
          sub={
            lines.length > 0 ? (
              <>
                {lines.map((l) => (
                  <span key={l} className="block">
                    {l}
                  </span>
                ))}
              </>
            ) : undefined
          }
          data-testid="figure-hero"
        />
        <span className="mt-2 block type-label text-moss underline decoration-1 underline-offset-4">
          How this is worked out
        </span>
      </button>
      {mounted && spine && (
        <Suspense fallback={null}>
          <AssumptionsSheet
            open={open}
            onOpenChange={setOpen}
            returnFocusRef={ref}
            spine={spine}
            position={position.data}
          />
        </Suspense>
      )}
    </div>
  );
}
