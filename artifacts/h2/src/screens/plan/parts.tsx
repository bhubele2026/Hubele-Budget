import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "wouter";
import { cx } from "@/lib/cx";
import { prefetchRoute } from "@/lib/routePrefetch";

/**
 * The small pieces the Plan screens share. Plan-local on purpose: S2 builds
 * beside this and the kit is the lead's to widen, so these stay here until the
 * lead folds the ones both want into `kit/`.
 */

export type PlanSection = "week" | "bills" | "debt" | "categories" | "wishlist";

const SECTIONS: ReadonlyArray<{ key: PlanSection; href: string; label: string }> = [
  { key: "week", href: "/plan", label: "The week" },
  { key: "bills", href: "/plan/bills", label: "Bills" },
  { key: "debt", href: "/plan/debt", label: "Debt" },
  { key: "categories", href: "/plan/categories", label: "Categories" },
  { key: "wishlist", href: "/plan/wishlist", label: "Wish list" },
];

/**
 * The section index. On a desktop it is a row of text links with a moss rule
 * under the current one; on a phone the same links become one segmented bar.
 */
export function PlanNav({ current }: { current: PlanSection }) {
  return (
    <nav aria-label="Plan sections" data-testid="plan-nav">
      <ul className="flex overflow-hidden rounded-1 border border-rule-strong md:gap-6 md:overflow-visible md:rounded-none md:border-0">
        {SECTIONS.map((s) => {
          const active = s.key === current;
          return (
            <li key={s.key} className="flex-auto md:flex-none">
              <Link
                href={s.href}
                aria-current={active ? "page" : undefined}
                onMouseEnter={() => prefetchRoute(s.href)}
                onFocus={() => prefetchRoute(s.href)}
                data-testid={`plan-nav-${s.key}`}
                className={cx(
                  "block whitespace-nowrap px-2 py-2 text-center type-label md:p-0 md:pb-1 md:text-left",
                  active
                    ? "bg-moss-wash text-moss-ink md:border-b-2 md:border-moss md:bg-transparent md:text-ink"
                    : "text-ink-2 hover:text-ink",
                )}
              >
                {s.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** The frame every Plan page sits in: the name, the section index, the page. */
export function PlanFrame({ current, children }: { current: PlanSection; children: ReactNode }) {
  return (
    <div className="flex flex-col" data-testid={`plan-${current}`}>
      <header className="mb-6 flex flex-col gap-4">
        <h1 className="type-headline text-ink">Plan</h1>
        <PlanNav current={current} />
      </header>
      {children}
    </div>
  );
}

/** A small set of choices where exactly one is picked (a radio group in a bar). */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  "data-testid": testId,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  disabled?: boolean;
  "data-testid"?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (e: KeyboardEvent, i: number) => {
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const n = (i + delta + options.length) % options.length;
    refs.current[n]?.focus();
    onChange(options[n]!.value);
  };
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex overflow-hidden rounded-1 border border-rule-strong" data-testid={testId}>
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => move(e, i)}
            data-testid={`${testId ?? "segmented"}-${o.value}`}
            className={cx(
              "h-10 px-4 type-label disabled:cursor-not-allowed disabled:opacity-50",
              i > 0 && "border-l border-rule-strong",
              on ? "bg-moss text-paper-0" : "bg-paper-0 text-ink hover:bg-paper-1",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export const inputClass =
  "h-10 w-full rounded-1 border border-rule-strong bg-paper-0 px-3 type-body text-ink placeholder:text-ink-3 disabled:bg-paper-1 disabled:text-ink-3";

/** A labelled control with its hint and its error in words. */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ReactNode;
}) {
  const id = useId();
  const noteId = `${id}-note`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="type-label text-ink-2">
        {label}
      </label>
      {children({ id, "aria-describedby": error || hint ? noteId : undefined, "aria-invalid": error ? true : undefined })}
      {(error || hint) && (
        <p id={noteId} className={cx("type-caption", error ? "text-clay" : "text-ink-3")} role={error ? "alert" : undefined}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

/** Dollars in a text field: a decimal keypad on a phone, "$" and commas welcome. */
export function MoneyInput({
  label,
  value,
  onChange,
  error,
  hint,
  disabled,
  placeholder,
  onCommit,
  "data-testid": testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
  hint?: ReactNode;
  disabled?: boolean;
  placeholder?: string;
  /** Called on Enter and on leaving the field. */
  onCommit?: () => void;
  "data-testid"?: string;
}) {
  return (
    <Field label={label} error={error} hint={hint}>
      {(a) => (
        <input
          {...a}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          className={cx(inputClass, "tnum font-mono")}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onCommit}
          onKeyDown={(e) => {
            if (e.key === "Enter" && onCommit) {
              e.preventDefault();
              onCommit();
            }
          }}
          data-testid={testId}
        />
      )}
    </Field>
  );
}

/** A confirmation line that says what happened, then goes. */
export function useToast(ms = 6000) {
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "error" } | null>(null);
  useEffect(() => {
    if (!msg) return;
    const id = window.setTimeout(() => setMsg(null), ms);
    return () => window.clearTimeout(id);
  }, [msg, ms]);
  const node = msg ? (
    <div
      role={msg.kind === "error" ? "alert" : "status"}
      data-testid="toast"
      data-kind={msg.kind}
      className={cx(
        "fixed inset-x-4 bottom-20 z-20 rounded-1 border bg-paper-0 px-3 py-2 type-body text-ink md:right-6 md:bottom-6 md:left-auto md:w-96",
        msg.kind === "error" ? "border-clay" : "border-rule-strong",
      )}
    >
      {msg.text}
    </div>
  ) : null;
  return { say: (text: string, kind: "ok" | "error" = "ok") => setMsg({ text, kind }), node };
}
