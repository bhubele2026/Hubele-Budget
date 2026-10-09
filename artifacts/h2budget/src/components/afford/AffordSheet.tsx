import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { householdToday } from "@workspace/avalanche-core/householdTime";
import { useGetMe, useListCategories, useListMembers, type Category } from "@workspace/api-client-react";
import {
  getGetMoneyPositionQueryKey,
  getListAllowancePlansQueryKey,
  getListWishlistQueryKey,
  useCreateWishlistItem,
  useEvaluateAfford,
  useGetMoneyPosition,
  useListAllowancePlans,
  type AffordResult,
} from "@workspace/api-client-react/features";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Help, btn, btnLink, btnSecondary, errorBanner, fieldLabel, input } from "@/ui";
import { OWN_INVALIDATION } from "@/lib/mutationInvalidation";
import { shortDate } from "@/lib/dates";
import { centsValue, fmtMoney, toAmount } from "@/lib/money";
import { VERDICT, apiMessage, comingSaturday, monthWord, parseDollars, refusal } from "@/lib/afford";

/**
 * ⭐ THE AFFORD SHEET — "Can we afford something?" One purchase, before and
 * after. Stateless: Check asks `POST /money/afford` and nothing is saved; only
 * "Add to wish list" writes, and only when pressed.
 *
 * ⚠️ NOTHING IS WORKED OUT HERE. The verdict, every before/after figure and the
 * months are the server's; this file lays them out. (F6; ported from the frozen
 * h2 app's AffordSheet and rebuilt on the h2budget dialog and tokens.)
 */

const MAX = 100_000;

function Money({ value }: { value: string | number | null | undefined }) {
  const n = toAmount(value);
  if (n == null) return <span className="text-neutral-400">—</span>;
  return (
    <data value={centsValue(n)} className="font-mono tabular-nums">
      {fmtMoney(n)}
    </data>
  );
}

/** One before → after line. Both figures always show, each to the cent in `<data value>`. */
export function Delta({
  label,
  tail,
  before,
  after,
  "data-testid": testId,
}: {
  label: string;
  tail?: string;
  before: string | null | undefined;
  after: string | null | undefined;
  "data-testid"?: string;
}) {
  return (
    <li
      className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-brand-line py-2 first:border-t-0"
      data-testid={testId}
    >
      <span className="text-body text-neutral-600">{label}</span>
      <span className="text-label font-semibold text-brand-navy">
        <Money value={before} />
        {tail ? ` ${tail}` : ""} <span aria-hidden>→</span>
        <span className="sr-only"> becomes </span> <Money value={after} />
      </span>
    </li>
  );
}

export function ResultBlock({ result, categoryName }: { result: AffordResult; categoryName: string | null }) {
  const v = VERDICT[result.verdict];
  const { baseline, proposed, debt } = result;
  const earliest = monthWord(proposed.debtFreeEarliest);
  const latest = monthWord(proposed.debtFreeLatest);
  const shift = debt.debtFreeMonthShift ?? 0;
  const range = earliest
    ? latest && latest !== earliest
      ? `${earliest}–${latest}`
      : latest
        ? earliest
        : `${earliest} or later`
    : null;
  return (
    <div className="flex flex-col gap-3" data-testid="afford-result" data-verdict={result.verdict}>
      <span className={`chip w-fit ${v.chip}`} data-testid="afford-verdict">
        {v.word}
      </span>
      <ul className="flex flex-col" data-testid="afford-deltas">
        <Delta label="Free until payday" before={baseline.availableUntilPayday} after={proposed.availableUntilPayday} data-testid="delta-payday" />
        <Delta label="This week" tail="left" before={baseline.remainingWeek} after={proposed.remainingWeek} data-testid="delta-week" />
        {result.category && (
          <Delta
            label={categoryName ?? "Category"}
            tail="left"
            before={result.category.remainingBefore}
            after={result.category.remainingAfter}
            data-testid="delta-category"
          />
        )}
      </ul>
      {range && (
        <p className="text-body text-neutral-600" data-testid="afford-debt">
          Debt-free: <span className="text-brand-navy">{range}</span> ·{" "}
          <span data-testid="afford-debt-shift">
            {shift > 0 ? `later by ${shift} ${shift === 1 ? "month" : "months"}` : "unchanged"}
          </span>
        </p>
      )}
      {result.assumptions.length > 0 && (
        <details className="text-micro text-neutral-500">
          <summary className="cursor-pointer font-semibold">What this assumes</summary>
          <ul className="mt-1 flex flex-col gap-1" data-testid="afford-assumptions">
            {result.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Field({
  label,
  error,
  htmlFor,
  children,
}: {
  label: string;
  error?: string | null;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className={fieldLabel}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-micro text-bad" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default function AffordSheet({
  open,
  onOpenChange,
  now,
  defaults,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  now?: Date;
  /** Start from a wish-list item or a typed question. */
  defaults?: { amount?: string; categoryId?: string; title?: string };
}) {
  const today = householdToday(now);
  const qc = useQueryClient();
  const evaluate = useEvaluateAfford();
  const create = useCreateWishlistItem({ mutation: { meta: OWN_INVALIDATION } });
  const categories = useListCategories({ query: { staleTime: 30 * 60_000, gcTime: 60 * 60_000, enabled: open } as never });
  const position = useGetMoneyPosition({
    query: { queryKey: getGetMoneyPositionQueryKey(), staleTime: 60_000, gcTime: 30 * 60_000, enabled: open },
  });
  const plans = useListAllowancePlans({
    query: { queryKey: getListAllowancePlansQueryKey(), staleTime: 5 * 60_000, gcTime: 30 * 60_000, enabled: open },
  });
  const me = useGetMe({ query: { staleTime: 30 * 60_000, gcTime: 60 * 60_000, enabled: open } as never });
  const members = useListMembers({
    query: { staleTime: 30 * 60_000, gcTime: 60 * 60_000, enabled: open && me.data?.isOwner === true } as never,
  });

  const [amount, setAmount] = useState(defaults?.amount ?? "");
  const [date, setDate] = useState(today);
  const [categoryId, setCategoryId] = useState(defaults?.categoryId ?? "");
  const [member, setMember] = useState("");
  const [tried, setTried] = useState(false);
  const [result, setResult] = useState<AffordResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [title, setTitle] = useState(defaults?.title ?? "");
  const [titleTried, setTitleTried] = useState(false);
  const [added, setAdded] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);

  const cats = useMemo(
    () => ((categories.data ?? []) as Category[]).filter((c) => !(c as { excludeFromBudget?: boolean }).excludeFromBudget),
    [categories.data],
  );
  const memberIds = useMemo(
    () => [...new Set((plans.data?.plans ?? []).filter((p) => p.memberUserId !== null).map((p) => p.memberUserId as string))],
    [plans.data],
  );
  const memberName = (id: string, i: number) => {
    const m = (members.data as Array<{ id: string; displayName?: string | null; email?: string | null }> | undefined)?.find(
      (x) => x.id === id,
    );
    return m?.displayName ?? m?.email ?? `Member ${i + 1}`;
  };

  const payday = position.data?.paydayDate ?? null;
  const chips: Array<{ key: string; label: string; date: string }> = [
    { key: "today", label: "Today", date: today },
    { key: "weekend", label: "This weekend", date: comingSaturday(today) },
    ...(payday && payday >= today ? [{ key: "payday", label: "Next payday", date: payday }] : []),
  ];

  const parsed = parseDollars(amount);
  const amountError =
    parsed == null || Number(parsed) <= 0
      ? "Enter a dollar amount above $0, like 120 or 120.50."
      : Number(parsed) > MAX
        ? "Enter $100,000 or less."
        : null;

  // Any change to the question clears the answer, so a result never sits beside inputs it was not made for.
  const touch = () => {
    setResult(null);
    setProblem(null);
    setAdded(false);
  };

  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => amountRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  const check = async () => {
    setTried(true);
    if (amountError || parsed == null) return;
    setProblem(null);
    try {
      const r = await evaluate.mutateAsync({
        data: {
          amount: Number(parsed),
          ...(date ? { date } : {}),
          ...(categoryId ? { categoryId } : {}),
          ...(member ? { member } : {}),
        },
      });
      setResult(r);
    } catch (e) {
      setResult(null);
      setProblem(refusal(e));
    }
  };

  const addToList = async () => {
    setTitleTried(true);
    if (!title.trim() || parsed == null) return;
    try {
      await create.mutateAsync({
        data: { title: title.trim(), amount: Number(parsed), ...(categoryId ? { categoryId } : {}) },
      });
      void qc.invalidateQueries({ queryKey: getListWishlistQueryKey() });
      setAdded(true);
      setNaming(false);
    } catch (e) {
      setProblem(apiMessage(e, "Couldn't add that. Nothing changed."));
    }
  };

  const nameId = result?.category?.categoryId ?? categoryId;
  const categoryName = nameId ? (cats.find((c) => c.id === nameId)?.name ?? null) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Can we afford something?</DialogTitle>
          <DialogDescription>A check only. Nothing is saved.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void check();
          }}
          data-testid="afford-form"
        >
          <Field label="How much" htmlFor="afford-amount" error={tried ? amountError : null}>
            <input
              id="afford-amount"
              ref={amountRef}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              className={`${input} font-mono tabular-nums`}
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                touch();
              }}
              data-testid="afford-amount"
            />
          </Field>

          <Field label="When" htmlFor="afford-date">
            <div className="flex flex-col gap-2">
              <div role="group" aria-label="Pick a day" className="flex flex-wrap gap-2">
                {chips.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    className={btnLink}
                    aria-pressed={date === c.date}
                    style={date === c.date ? { background: "var(--color-platinum-3)" } : undefined}
                    onClick={() => {
                      setDate(c.date);
                      touch();
                    }}
                    data-testid={`afford-when-${c.key}`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              <input
                id="afford-date"
                type="date"
                min={today}
                value={date}
                onChange={(e) => {
                  setDate(e.target.value || today);
                  touch();
                }}
                className={input}
                data-testid="afford-date"
              />
            </div>
          </Field>

          <Field label="Category (optional)" htmlFor="afford-category">
            <select
              id="afford-category"
              value={categoryId}
              onChange={(e) => {
                setCategoryId(e.target.value);
                touch();
              }}
              className={input}
              data-testid="afford-category"
            >
              <option value="">No category</option>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>

          {memberIds.length > 0 && (
            <Field label="Whose (optional)" htmlFor="afford-member">
              <select
                id="afford-member"
                value={member}
                onChange={(e) => {
                  setMember(e.target.value);
                  touch();
                }}
                className={input}
                data-testid="afford-member"
              >
                <option value="">The household</option>
                {memberIds.map((id, i) => (
                  <option key={id} value={id}>
                    {memberName(id, i)}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <div className="flex gap-3">
            <button type="submit" className={btn} disabled={evaluate.isPending} data-testid="afford-check">
              Check
            </button>
            <button type="button" className={btnSecondary} onClick={() => onOpenChange(false)} data-testid="afford-close">
              Close
            </button>
          </div>
        </form>

        {problem && (
          <div className={errorBanner} data-testid="afford-problem" role="alert">
            {problem}
          </div>
        )}

        {result && (
          <div className="border-t border-brand-line pt-4">
            <p className="mb-3 text-micro text-neutral-500" data-testid="afford-asked">
              <Money value={result.amount} /> on {shortDate(result.dateISO)}
              <Help className="ml-2">The verdict and every figure here come from the server's plan, not from this screen.</Help>
            </p>
            <ResultBlock result={result} categoryName={categoryName} />
            <div className="mt-4 flex flex-col gap-3">
              {added ? (
                <p className="text-body text-neutral-600" role="status" data-testid="afford-added">
                  Added to the wish list.
                </p>
              ) : naming ? (
                <form
                  className="flex flex-col gap-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void addToList();
                  }}
                  data-testid="afford-wish-form"
                >
                  <Field label="What is it" htmlFor="afford-wish-title" error={titleTried && !title.trim() ? "Say what it is." : null}>
                    <input
                      id="afford-wish-title"
                      type="text"
                      maxLength={120}
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      className={input}
                      data-testid="afford-wish-title"
                    />
                  </Field>
                  <div className="flex gap-3">
                    <button type="submit" className={btn} disabled={create.isPending} data-testid="afford-wish-save">
                      Add
                    </button>
                    <button type="button" className={btnSecondary} onClick={() => setNaming(false)}>
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <div>
                  <button type="button" className={btnSecondary} onClick={() => setNaming(true)} data-testid="afford-wish">
                    Add to wish list
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
