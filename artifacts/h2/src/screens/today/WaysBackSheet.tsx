import { useState, type RefObject } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetMeQueryKey,
  getGetWaysBackQueryKey,
  useCreateWeekAdjustment,
  useDeleteWeekAdjustment,
  useGetMe,
  useGetWaysBack,
  type WaysBack,
} from "@workspace/api-client-react";
import { invalidateAfterWrite, OWN_INVALIDATION } from "@/data/mutationInvalidation";
import { Button, buttonClass } from "@/kit/Button";
import { Note } from "@/kit/Note";
import { Sheet } from "@/kit/Sheet";
import { SkeletonLine } from "@/kit/Skeleton";
import { fmtMoney } from "@/lib/money";
import { weekdayName } from "./words";

/** Whole cents from the API, formatted as the app's whole-dollar money. Formatting only. */
const fmtCents = (cents: number | null | undefined) => fmtMoney(cents == null ? null : cents / 100);

/**
 * ⭐ A WAY BACK — three honest options for a week that is over its limit, every
 * figure read from `GET /money/ways-back` (whole cents). Nothing is worked out
 * here, nothing is chosen for the household, and nothing is a lecture.
 *
 * Carrying a week over is the owner's decision (the server refuses anyone else);
 * a member sees the option, disabled, with whom to ask.
 *
 * Lazy: it loads the first time the card's button is pressed (and is warmed on
 * hover/focus), never on the open path. `sample` renders it on made-up data
 * with no network (the public /design/today page).
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

const optionClass = "border-t border-rule py-4 first:border-t-0 first:pt-0";

export function WaysBackBody({ ways, owner, ownerName, busy, error, onCarry, onUndo }: BodyProps) {
  const { hold, trims, carryOver } = ways;
  const lower = carryOver.adjustment ? fmtCents(-carryOver.adjustment.amountCents) : fmtCents(ways.overBy);
  return (
    <div className="flex flex-col" data-testid="ways-back">
      <section className={optionClass} data-testid="way-hold">
        <h3 className="type-label text-ink">Hold</h3>
        <p className="mt-1 type-body text-ink-2">
          Nothing non-essential until {weekdayName(ways.weekEnd)}.
          {hold.leavesUntilPayday != null && <> That keeps {fmtCents(hold.leavesUntilPayday)} until payday.</>}
        </p>
      </section>

      {trims.length > 0 && (
        <section className={optionClass} data-testid="way-trim">
          <h3 className="type-label text-ink">Trim</h3>
          <ul className="mt-1 flex flex-col">
            {trims.slice(0, 3).map((t) => (
              <li key={t.categoryId} className="py-1" data-testid="way-trim-row">
                <Link href="/plan/categories" className={buttonClass({ variant: "link", size: "sm" })}>
                  {t.name}
                </Link>
                <span className="block type-caption text-ink-2">
                  spent {fmtCents(t.spentWeek)} this week
                  {t.usualWeek != null && <> · usually {fmtCents(t.usualWeek)}</>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={optionClass} data-testid="way-carry">
        <h3 className="type-label text-ink">Carry it over</h3>
        {carryOver.applied ? (
          <>
            <p className="mt-1 type-body text-ink-2" data-testid="carry-applied">
              Carried over. Next week starts {lower} lower.
            </p>
            {owner && (
              <div className="mt-3">
                <Button onClick={onUndo} disabled={busy} data-testid="carry-undo">
                  Undo
                </Button>
              </div>
            )}
          </>
        ) : carryOver.nextWeekCap != null ? (
          <>
            <p className="mt-1 type-body text-ink-2">
              Next week starts {fmtCents(ways.overBy)} lower, at {fmtCents(carryOver.nextWeekCap)}.
            </p>
            <div className="mt-3">
              {owner ? (
                <Button variant="primary" onClick={onCarry} disabled={busy} data-testid="carry-go">
                  Carry it over
                </Button>
              ) : (
                <Button disabled data-testid="carry-ask">
                  Ask {ownerName} to carry it over
                </Button>
              )}
            </div>
          </>
        ) : (
          <p className="mt-1 type-body text-ink-2">Next week has no limit set, so there is nothing to lower.</p>
        )}
        {error && (
          <p className="mt-2 type-caption text-clay" role="alert" data-testid="carry-error">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}

const SHEET = { title: "A way back", description: "Pick one, or none. It is your week." } as const;

function errorWords(e: unknown): string {
  const status = (e as { status?: number } | null)?.status;
  return status === 403 ? "Only the household owner can do this." : "Couldn't save that. Try again.";
}

function LiveBody({ ownerName }: { ownerName: string }) {
  const qc = useQueryClient();
  const q = useGetWaysBack({ query: { queryKey: getGetWaysBackQueryKey(), staleTime: 0 } });
  const me = useGetMe({ query: { queryKey: getGetMeQueryKey(), staleTime: 30 * 60_000, gcTime: 60 * 60_000 } });
  const [error, setError] = useState<string | null>(null);
  // The sheet invalidates once, itself: the spine, the position and the ways back.
  const create = useCreateWeekAdjustment({ mutation: { meta: OWN_INVALIDATION } });
  const del = useDeleteWeekAdjustment({ mutation: { meta: OWN_INVALIDATION } });
  const ways = q.data;
  if (!ways) {
    return q.isError ? (
      <Note kind="error" onRetry={() => void q.refetch()} retrying={q.isFetching}>
        Couldn't load the ways back.
      </Note>
    ) : (
      <SkeletonLine className="w-56" />
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
      owner={me.data?.isOwner === true}
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

function SampleBody({ sample, owner }: { sample: WaysBack; owner: boolean }) {
  const [applied, setApplied] = useState(false);
  const ways: WaysBack = applied
    ? { ...sample, carryOver: { ...sample.carryOver, applied: true, adjustment: { weekStart: sample.carryOver.nextWeekStart, amountCents: -sample.overBy, reason: "carry_over" } } }
    : sample;
  return (
    <WaysBackBody ways={ways} owner={owner} ownerName="the owner" busy={false} error={null} onCarry={() => setApplied(true)} onUndo={() => setApplied(false)} />
  );
}

export default function WaysBackSheet({
  open,
  onOpenChange,
  returnFocusRef,
  sample,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  sample?: WaysBack;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} returnFocusRef={returnFocusRef} {...SHEET}>
      {sample ? <SampleBody sample={sample} owner /> : <LiveBody ownerName="the owner" />}
    </Sheet>
  );
}
