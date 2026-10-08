import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { addDaysISO, dayOfWeekISO, householdToday } from "@workspace/avalanche-core/householdTime";
import {
  getGetMeQueryKey,
  getGetMoneyPositionQueryKey,
  getListAllowancePlansQueryKey,
  getListCategoriesQueryKey,
  getListMembersQueryKey,
  getListWishlistQueryKey,
  useCreateWishlistItem,
  useEvaluateAfford,
  useGetMe,
  useGetMoneyPosition,
  useListAllowancePlans,
  useListCategories,
  useListMembers,
  type AffordResult,
  type Category,
} from "@workspace/api-client-react";
import { OWN_INVALIDATION } from "@/data/mutationInvalidation";
import { Button } from "@/kit/Button";
import { Disclosure } from "@/kit/Disclosure";
import { Note } from "@/kit/Note";
import { Sheet } from "@/kit/Sheet";
import { StatusWord } from "@/kit/StatusWord";
import { shortDate } from "@/lib/dates";
import { centsValue, fmtMoney, toAmount } from "@/lib/money";
import { apiMessage } from "@/screens/household/words";
import { Field, inputClass } from "@/screens/plan/parts";
import { parseDollars } from "@/screens/plan/format";
import { VERDICT, monthWord } from "./verdict";

/**
 * ⭐ THE AFFORD SHEET — "Can we afford something?" One purchase, before and
 * after. Stateless: Check asks `POST /money/afford` and nothing is saved;
 * only "Add to wish list" writes, and only when pressed.
 *
 * ⚠️ NOTHING IS WORKED OUT HERE. The verdict, every before/after figure and
 * the months are the server's (`evaluateAfford`); this file lays them out.
 * The "later by N months" is the server's `debtFreeMonthShift` as it came.
 */

const MAX = 100_000;
/** The coming Saturday: today when today is one. */
export function comingSaturday(today: string): string {
  return addDaysISO(today, (6 - dayOfWeekISO(today) + 7) % 7);
}

function Money({ value }: { value: string | number | null | undefined }) {
  const n = toAmount(value);
  if (n == null) return <span className="text-ink-3">—</span>;
  return (
    <data value={centsValue(n)} className="tnum">
      {fmtMoney(n)}
    </data>
  );
}

/** One before → after line. Both figures always show, each to the cent in `<data value>`. */
export function Delta({ label, tail, before, after, "data-testid": testId }: { label: string; tail?: string; before: string | null | undefined; after: string | null | undefined; "data-testid"?: string }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-rule py-2 first:border-t-0" data-testid={testId}>
      <span className="type-body text-ink-2">{label}</span>
      <span className="type-figure-sm text-ink">
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
  const range = earliest ? (latest && latest !== earliest ? `${earliest}–${latest}` : latest ? earliest : `${earliest} or later`) : null;
  return (
    <div className="flex flex-col gap-3" data-testid="afford-result" data-verdict={result.verdict}>
      <StatusWord tone={v.tone} data-testid="afford-verdict">
        {v.word}
      </StatusWord>
      <ul className="flex flex-col" data-testid="afford-deltas">
        <Delta label="Free until payday" before={baseline.availableUntilPayday} after={proposed.availableUntilPayday} data-testid="delta-payday" />
        <Delta label="This week" tail="left" before={baseline.remainingWeek} after={proposed.remainingWeek} data-testid="delta-week" />
        {result.category && (
          <Delta label={categoryName ?? "Category"} tail="left" before={result.category.remainingBefore} after={result.category.remainingAfter} data-testid="delta-category" />
        )}
      </ul>
      {range && (
        <p className="type-body text-ink-2" data-testid="afford-debt">
          Debt-free: <span className="text-ink">{range}</span> ·{" "}
          <span data-testid="afford-debt-shift">{shift > 0 ? `later by ${shift} ${shift === 1 ? "month" : "months"}` : "unchanged"}</span>
        </p>
      )}
      {result.assumptions.length > 0 && (
        <Disclosure summary="What this assumes">
          <ul className="flex flex-col gap-1" data-testid="afford-assumptions">
            {result.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}

/** Words for the server's refusals; anything else gets a plain fallback. */
function refusal(e: unknown): string {
  const data = (e as { data?: { error?: unknown } } | null)?.data;
  if (data?.error === "date_past_window") return "That day is further out than H2 can see. Pick an earlier day.";
  const status = (e as { status?: number } | null)?.status;
  if (status === 404) return "H2 couldn't find that category or member. Pick again.";
  return apiMessage(e, "Couldn't check that. Nothing changed.");
}

/** Made-up input for the public sample page: the sheet opens on this, with no request. */
export interface AffordSample {
  amount: string;
  date?: string;
  categoryId?: string;
  categoryName?: string;
  result: AffordResult;
}

export default function AffordSheet({
  open,
  onOpenChange,
  returnFocusRef,
  now,
  sample,
  defaults,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  now?: Date;
  sample?: AffordSample;
  /** Start from a wish-list item or a typed question. */
  defaults?: { amount?: string; categoryId?: string; title?: string };
}) {
  const today = householdToday(now);
  const live = !sample && open;
  const qc = useQueryClient();
  const evaluate = useEvaluateAfford();
  const create = useCreateWishlistItem({ mutation: { meta: OWN_INVALIDATION } });
  const categories = useListCategories({ query: { queryKey: getListCategoriesQueryKey(), staleTime: 30 * 60_000, gcTime: 60 * 60_000, enabled: live } });
  const position = useGetMoneyPosition({ query: { queryKey: getGetMoneyPositionQueryKey(), staleTime: 60_000, gcTime: 30 * 60_000, enabled: live } });
  const plans = useListAllowancePlans({ query: { queryKey: getListAllowancePlansQueryKey(), staleTime: 5 * 60_000, gcTime: 30 * 60_000, enabled: live } });
  const me = useGetMe({ query: { queryKey: getGetMeQueryKey(), staleTime: 30 * 60_000, gcTime: 60 * 60_000, enabled: live } });
  const members = useListMembers({ query: { queryKey: getListMembersQueryKey(), staleTime: 30 * 60_000, gcTime: 60 * 60_000, enabled: live && me.data?.isOwner === true } });

  const [amount, setAmount] = useState(sample?.amount ?? defaults?.amount ?? "");
  const [date, setDate] = useState(sample?.date ?? today);
  const [categoryId, setCategoryId] = useState(sample?.categoryId ?? defaults?.categoryId ?? "");
  const [member, setMember] = useState("");
  const [tried, setTried] = useState(false);
  const [result, setResult] = useState<AffordResult | null>(sample?.result ?? null);
  const [problem, setProblem] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [title, setTitle] = useState(defaults?.title ?? "");
  const [titleTried, setTitleTried] = useState(false);
  const [added, setAdded] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);

  const cats = useMemo(() => ((categories.data ?? []) as Category[]).filter((c) => !c.excludeFromBudget), [categories.data]);
  const memberIds = useMemo(
    () => [...new Set((plans.data?.plans ?? []).filter((p) => p.memberUserId !== null).map((p) => p.memberUserId as string))],
    [plans.data],
  );
  const memberName = (id: string, i: number) => {
    const m = members.data?.find((x) => x.id === id);
    return m?.displayName ?? m?.email ?? `Member ${i + 1}`;
  };

  const payday = position.data?.paydayDate ?? null;
  const chips: Array<{ key: string; label: string; date: string }> = [
    { key: "today", label: "Today", date: today },
    { key: "weekend", label: "This weekend", date: comingSaturday(today) },
    ...(payday && payday >= today ? [{ key: "payday", label: "Next payday", date: payday }] : []),
  ];

  const parsed = parseDollars(amount);
  const amountError = parsed == null || Number(parsed) <= 0 ? "Enter a dollar amount above $0, like 120 or 120.50." : Number(parsed) > MAX ? "Enter $100,000 or less." : null;

  // Any change to the question clears the answer, so a result never sits beside inputs it was not made for.
  const touch = () => {
    setResult(null);
    setProblem(null);
    setAdded(false);
  };

  // The first open puts the cursor in the amount.
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
      await create.mutateAsync({ data: { title: title.trim(), amount: Number(parsed), ...(categoryId ? { categoryId } : {}) } });
      void qc.invalidateQueries({ queryKey: getListWishlistQueryKey() });
      setAdded(true);
      setNaming(false);
    } catch (e) {
      setProblem(apiMessage(e, "Couldn't add that. Nothing changed."));
    }
  };

  const nameId = result?.category?.categoryId ?? categoryId;
  const categoryName = nameId ? (cats.find((c) => c.id === nameId)?.name ?? sample?.categoryName ?? null) : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Can we afford something?" description="A check only. Nothing is saved." returnFocusRef={returnFocusRef}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void check();
        }}
        data-testid="afford-form"
      >
        <Field label="How much" error={tried ? amountError : null}>
          {(a) => (
            <input
              {...a}
              ref={amountRef}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              className={`${inputClass} tnum font-mono`}
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                touch();
              }}
              data-testid="afford-amount"
            />
          )}
        </Field>

        <Field label="When">
          {(a) => (
            <div className="flex flex-col gap-2">
              <div role="group" aria-label="Pick a day" className="flex flex-wrap gap-2">
                {chips.map((c) => (
                  <Button
                    key={c.key}
                    size="sm"
                    variant="quiet"
                    aria-pressed={date === c.date}
                    className={date === c.date ? "bg-paper-2" : undefined}
                    onClick={() => {
                      setDate(c.date);
                      touch();
                    }}
                    data-testid={`afford-when-${c.key}`}
                  >
                    {c.label}
                  </Button>
                ))}
              </div>
              <input
                {...a}
                type="date"
                min={today}
                value={date}
                onChange={(e) => {
                  setDate(e.target.value || today);
                  touch();
                }}
                className={inputClass}
                data-testid="afford-date"
              />
            </div>
          )}
        </Field>

        <Field label="Category (optional)">
          {(a) => (
            <select
              {...a}
              value={categoryId}
              onChange={(e) => {
                setCategoryId(e.target.value);
                touch();
              }}
              className={inputClass}
              data-testid="afford-category"
            >
              <option value="">No category</option>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </Field>

        {memberIds.length > 0 && (
          <Field label="Whose (optional)">
            {(a) => (
              <select
                {...a}
                value={member}
                onChange={(e) => {
                  setMember(e.target.value);
                  touch();
                }}
                className={inputClass}
                data-testid="afford-member"
              >
                <option value="">The household</option>
                {memberIds.map((id, i) => (
                  <option key={id} value={id}>
                    {memberName(id, i)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}

        <div className="flex gap-3">
          <Button type="submit" variant="primary" disabled={evaluate.isPending} data-testid="afford-check">
            Check
          </Button>
          <Button onClick={() => onOpenChange(false)} data-testid="afford-close">
            Close
          </Button>
        </div>
      </form>

      {problem && (
        <div className="mt-4">
          <Note kind="error" data-testid="afford-problem">
            {problem}
          </Note>
        </div>
      )}

      {result && (
        <div className="mt-6 border-t border-rule pt-4">
          <p className="mb-3 type-caption text-ink-3" data-testid="afford-asked">
            <Money value={result.amount} /> on {shortDate(result.dateISO)}
          </p>
          <ResultBlock result={result} categoryName={categoryName} />
          <div className="mt-4 flex flex-col gap-3">
            {added ? (
              <p className="type-body text-ink-2" role="status" data-testid="afford-added">
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
                <Field label="What is it" error={titleTried && !title.trim() ? "Say what it is." : null}>
                  {(a) => <input {...a} type="text" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} data-testid="afford-wish-title" />}
                </Field>
                <div className="flex gap-3">
                  <Button type="submit" variant="primary" disabled={create.isPending} data-testid="afford-wish-save">
                    Add
                  </Button>
                  <Button onClick={() => setNaming(false)}>Cancel</Button>
                </div>
              </form>
            ) : (
              <div>
                <Button onClick={() => setNaming(true)} data-testid="afford-wish">
                  Add to wish list
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </Sheet>
  );
}
