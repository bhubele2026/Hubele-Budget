import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useGetMe } from "@workspace/api-client-react";
import {
  getGetWaysBackQueryKey,
  useCreateWeekAdjustment,
  useDeleteWeekAdjustment,
  useGetWaysBack,
  type WaysBack,
} from "@workspace/api-client-react/features";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { btn, btnLink, btnSecondary, emptyNote, errorBanner } from "@/ui";
import { invalidateAfterWrite, OWN_INVALIDATION } from "@/lib/mutationInvalidation";
import { errorWords, fmtCents, weekdayName } from "@/lib/waysBack";

/**
 * ⭐ A WAY BACK — three honest options for a week that is over its limit, every
 * figure read from `GET /money/ways-back` (whole cents). Nothing is worked out
 * here, nothing is chosen for the household, and nothing is a lecture.
 *
 * Carrying a week over is the owner's decision (the server refuses anyone else);
 * a member sees the option, disabled, with whom to ask. (F7; ported from h2.)
 */
interface BodyProps {
  ways: WaysBack;
  owner: boolean;
  ownerName: string;
  busy: boolean;
  error: string | null;
  onCarry: () => void;
  onUndo: () => void;
}

const optionClass = "border-t border-brand-line py-4 first:border-t-0 first:pt-0";

export function WaysBackBody({ ways, owner, ownerName, busy, error, onCarry, onUndo }: BodyProps) {
  const { hold, trims, carryOver } = ways;
  const lower = carryOver.adjustment ? fmtCents(-carryOver.adjustment.amountCents) : fmtCents(ways.overBy);
  return (
    <div className="flex flex-col" data-testid="ways-back">
      {ways.overBy === 0 && (
        <p className="pb-3 text-body text-neutral-600" data-testid="ways-back-not-over">
          You are not over this week's limit.
        </p>
      )}
      <section className={optionClass} data-testid="way-hold">
        <h3 className="text-label font-semibold text-brand-navy">Hold</h3>
        <p className="mt-1 text-body text-neutral-600">
          Nothing non-essential until {weekdayName(ways.weekEnd)}.
          {hold.leavesUntilPayday != null && <> That keeps {fmtCents(hold.leavesUntilPayday)} until payday.</>}
        </p>
      </section>

      {trims.length > 0 && (
        <section className={optionClass} data-testid="way-trim">
          <h3 className="text-label font-semibold text-brand-navy">Trim</h3>
          <ul className="mt-1 flex flex-col">
            {trims.slice(0, 3).map((t) => (
              <li key={t.categoryId} className="py-1" data-testid="way-trim-row">
                <Link href="/budget" className={btnLink}>
                  {t.name}
                </Link>
                <span className="mt-0.5 block text-micro text-neutral-600">
                  spent {fmtCents(t.spentWeek)} this week
                  {t.usualWeek != null && <> · usually {fmtCents(t.usualWeek)}</>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={optionClass} data-testid="way-carry">
        <h3 className="text-label font-semibold text-brand-navy">Carry it over</h3>
        {carryOver.applied ? (
          <>
            <p className="mt-1 text-body text-neutral-600" data-testid="carry-applied">
              Carried over. Next week starts {lower} lower.
            </p>
            {owner && (
              <div className="mt-3">
                <button type="button" className={btnSecondary} onClick={onUndo} disabled={busy} data-testid="carry-undo">
                  Undo
                </button>
              </div>
            )}
          </>
        ) : carryOver.nextWeekCap != null ? (
          <>
            <p className="mt-1 text-body text-neutral-600">
              Next week starts {fmtCents(ways.overBy)} lower, at {fmtCents(carryOver.nextWeekCap)}.
            </p>
            <div className="mt-3">
              {owner ? (
                <button type="button" className={btn} onClick={onCarry} disabled={busy || ways.overBy === 0} data-testid="carry-go">
                  Carry it over
                </button>
              ) : (
                <button type="button" className={btnSecondary} disabled data-testid="carry-ask">
                  Ask {ownerName} to carry it over
                </button>
              )}
            </div>
          </>
        ) : (
          <p className="mt-1 text-body text-neutral-600">Next week has no limit set, so there is nothing to lower.</p>
        )}
        {error && (
          <p className="mt-2 text-micro text-bad" role="alert" data-testid="carry-error">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}

function LiveBody({ ownerName }: { ownerName: string }) {
  const qc = useQueryClient();
  const q = useGetWaysBack({ query: { queryKey: getGetWaysBackQueryKey(), staleTime: 0 } });
  const me = useGetMe({ query: { staleTime: 30 * 60_000, gcTime: 60 * 60_000 } as never });
  const [error, setError] = useState<string | null>(null);
  // The sheet invalidates once, itself: the rule marks the spine, the money position and the ways back.
  const create = useCreateWeekAdjustment({ mutation: { meta: OWN_INVALIDATION } });
  const del = useDeleteWeekAdjustment({ mutation: { meta: OWN_INVALIDATION } });
  const ways = q.data;
  if (!ways) {
    return q.isError ? (
      <div className={errorBanner} role="alert">
        Couldn't load the ways back.{" "}
        <button type="button" className={btnLink} onClick={() => void q.refetch()}>
          Try again
        </button>
      </div>
    ) : (
      <div className={emptyNote} aria-busy="true">
        Loading…
      </div>
    );
  }
  const done = {
    onSuccess: () => {
      setError(null);
      invalidateAfterWrite(qc);
    },
    onError: (e: unknown) => setError(errorWords(e)),
  };
  return (
    <WaysBackBody
      ways={ways}
      owner={(me.data as { isOwner?: boolean } | undefined)?.isOwner === true}
      ownerName={ownerName}
      busy={create.isPending || del.isPending}
      error={error}
      onCarry={() =>
        create.mutate(
          { data: { weekStart: ways.carryOver.nextWeekStart, amountCents: -ways.overBy, reason: "carry_over" } },
          done,
        )
      }
      onUndo={() => del.mutate({ weekStart: ways.carryOver.nextWeekStart }, done)}
    />
  );
}

export default function WaysBackSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>A way back</DialogTitle>
          <DialogDescription>Pick one, or none. It is your week.</DialogDescription>
        </DialogHeader>
        {open ? <LiveBody ownerName="the owner" /> : null}
      </DialogContent>
    </Dialog>
  );
}
