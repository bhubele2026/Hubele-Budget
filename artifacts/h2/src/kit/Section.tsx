import { useId, type ReactNode } from "react";

/**
 * A section of a screen: a hairline rule, a serif label, the content, and an
 * optional foot. Sections are separated by rules, never by cards; nothing in
 * the app floats above the paper.
 */
export function Section({
  label,
  action,
  foot,
  children,
  "data-testid": testId,
}: {
  label: string;
  /** One quiet control, right-aligned on the label line. */
  action?: ReactNode;
  /** A caption under the content. */
  foot?: ReactNode;
  children: ReactNode;
  "data-testid"?: string;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="border-t border-rule pt-4 pb-8" data-testid={testId}>
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 id={headingId} className="type-section text-ink-2">
          {label}
        </h2>
        {action && <div className="type-label">{action}</div>}
      </div>
      {children}
      {foot && <div className="mt-3 type-caption text-ink-3">{foot}</div>}
    </section>
  );
}
