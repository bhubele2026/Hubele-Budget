import { cx } from "@/lib/cx";

/**
 * The category on a charge, as a chip you can press. Not filed reads
 * "Not filed" on a dashed outline; a category H2 chose but a person has not
 * confirmed (`provisional`) has a dotted outline AND the word "provisional",
 * so the state never rests on the outline alone.
 */
export function CategoryChip({
  name,
  provisional = false,
  onPress,
  label,
  "data-testid": testId = "category-chip",
}: {
  name: string | null | undefined;
  provisional?: boolean;
  /** Absent: the chip is read-only text. */
  onPress?: () => void;
  /** The accessible name when pressed, e.g. "Change category for Corner Market". */
  label?: string;
  "data-testid"?: string;
}) {
  const outline = name
    ? provisional
      ? "border-dotted border-ink-3"
      : "border-rule-strong"
    : "border-dashed border-rule-strong";
  const face = (
    <>
      {name ?? "Not filed"}
      {provisional && <span className="ml-1 text-ink-3">provisional</span>}
    </>
  );
  const cls = cx("inline-flex items-center rounded-1 border px-2 py-0.5 type-caption text-ink-2", outline);
  if (!onPress) {
    return (
      <span className={cls} data-testid={testId} data-provisional={provisional ? "" : undefined}>
        {face}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onPress}
      aria-haspopup="dialog"
      aria-label={label ? `${label}. ${name ?? "Not filed"}${provisional ? ", provisional" : ""}` : undefined}
      className={cx(cls, "min-h-6 hover:bg-paper-1")}
      data-testid={testId}
      data-provisional={provisional ? "" : undefined}
    >
      {face}
    </button>
  );
}
