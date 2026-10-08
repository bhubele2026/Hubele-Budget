import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { Button, buttonClass } from "./Button";

/**
 * ⭐ THE ONE THING — a single item that wants a look, or the plain news that
 * nothing does. The title is one short line (60 characters at most: the
 * Today test holds it); the optional detail is one more.
 *
 * It is set on the paper like the rest of the screen: a rule and words, no
 * card. The action is a link (the app has no router destination yet for most
 * of what it asks), and "Next" steps to the next item without saving anything.
 */
export const ACTION_TITLE_MAX = 60;

export function ActionCard({
  title,
  detail,
  action,
  onNext,
  done = false,
  "data-testid": testId,
}: {
  title: string;
  detail?: string;
  action?: { label: string; href: string };
  /** Present only when there is another item to step to. */
  onNext?: () => void;
  /** Nothing needs the person: the title is drawn with a check. */
  done?: boolean;
  "data-testid"?: string;
}): ReactNode {
  return (
    <div className="flex flex-col gap-3" data-testid={testId} data-done={done ? "" : undefined}>
      <p className="flex items-start gap-2 type-headline text-ink" data-testid="action-title">
        {done && <Check size={20} strokeWidth={1.75} aria-hidden className="mt-1 shrink-0 text-moss" />}
        <span>{title}</span>
      </p>
      {detail && <p className="type-body text-ink-2">{detail}</p>}
      {(action || onNext) && (
        <div className="flex flex-wrap items-center gap-3">
          {action && (
            <a href={action.href} className={buttonClass({ variant: "primary", size: "md" })}>
              {action.label}
            </a>
          )}
          {onNext && (
            <Button variant="quiet" onClick={onNext}>
              Next
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
