// ⭐ A FIGURE THAT CHANGES ON A CLICK ROLLS TO ITS NEW VALUE (ported from the KFI dashboard's FigureRoll, 2026-11-12:
// "no click should ever be abrupt"). The old text slides up and out while the new text rises into the same cell, so only
// the old or the new number is ever on screen — never an in-between: a figure NEVER counts.
//
// - The two texts share one grid cell, so nothing around the figure moves while it rolls.
// - First paint never rolls; the same text never rolls; a dash or a word filling in with a figure is a plain swap
//   (only figure → figure rolls); a figure off screen never rolls; reduced motion shows the new value at once.
// - A figure lower on the screen starts a little later, so a page of changed figures rolls top to bottom.
// - The outgoing text is aria-hidden: assistive tech only ever reads the final value.
// - No colour wash: H2 cannot always say whether a move is good news, and a missing colour beats a wrong one.
import { useLayoutEffect, useRef, useState } from "react";
import { reducedMotion } from "@/lib/motion";

const MAX_DELAY_MS = 420;

/** Text that IS a figure: a sign, a $ or a parenthesis, then a digit. "—", "Loading…" are not. */
export const isFigureText = (s: string): boolean => /^[+\-−(]?\$?[+\-−]?\d/.test(s.trim());

export function Roll({ value, className = "" }: { value: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const last = useRef(value);
  const seq = useRef(0);
  const [roll, setRoll] = useState<{ id: number; from: string; delay: number } | null>(null);

  // Before paint: the frame that first shows the new value already has it rolling in.
  useLayoutEffect(() => {
    const was = last.current;
    last.current = value;
    if (was === value) return;
    if (reducedMotion() || !isFigureText(was) || !isFigureText(value)) return setRoll(null);
    const r = ref.current?.getBoundingClientRect();
    const vh = window.innerHeight || 1;
    if (!r || r.bottom < 0 || r.top > vh) return setRoll(null);
    seq.current += 1;
    setRoll({ id: seq.current, from: was, delay: Math.round(Math.min(1, Math.max(0, r.top / vh)) * MAX_DELAY_MS) });
  }, [value]);

  // At rest the figure is plain text in its own box (nothing wraps it); an empty probe beside it says where it sits.
  if (!roll) {
    return (
      <>
        {value}
        <span ref={ref} aria-hidden data-roll="probe" />
      </>
    );
  }
  const style = { animationDelay: `${roll.delay}ms`, gridArea: "1 / 1" };
  return (
    <span ref={ref} className={`relative inline-grid overflow-clip ${className}`}>
      <span key={`o${roll.id}`} aria-hidden className="roll-out whitespace-nowrap" style={style} data-roll="out">
        {roll.from}
      </span>
      <span
        key={`i${roll.id}`}
        className="roll-in whitespace-nowrap"
        style={style}
        onAnimationEnd={() => setRoll((r) => (r && r.id === roll.id ? null : r))}
      >
        {value}
      </span>
    </span>
  );
}
