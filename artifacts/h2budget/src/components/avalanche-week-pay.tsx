// ⭐ (AVAL-W) The "We paid it" button, its Undo and its error line — the same
// controls on the home page's avalanche box and the Debt page's weekly panel
// (state: `lib/avalancheWeekPay.ts`; the writes: `hooks/useAvalancheWeekPay.ts`).
// Lazy chunks only.

import type { AvalancheWeeklyLastPaid } from "@workspace/api-client-react";
import { btnSecondarySm } from "@/ui";
import { cn } from "@/lib/utils";
import type { AvalancheWeekPayControls } from "@/hooks/useAvalancheWeekPay";

/**
 * The call to action: NAVY with white words, the app's one primary button
 * (owner, 2026-11-12 — orange is kept for warnings and the H2 mark). Flat and
 * matte; at least 36 px tall so a thumb finds it.
 */
export const WEEK_PAY_CTA =
  "press inline-flex min-h-9 items-center justify-center rounded-control bg-brand-navy px-4 py-1.5 text-body font-medium text-white hover:bg-brand-navy2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-55";

export function WeekPayButton({ controls, date, className }: { controls: AvalancheWeekPayControls; date: string; className?: string }) {
  return (
    <button
      type="button"
      className={cn(WEEK_PAY_CTA, className)}
      disabled={controls.paying || controls.undoing}
      onClick={() => controls.pay(date)}
      data-testid="week-pay-button"
    >
      {controls.paying ? "Saving…" : "We paid it"}
    </button>
  );
}

export function WeekUndoButton({ controls, paid }: { controls: AvalancheWeekPayControls; paid: Pick<AvalancheWeeklyLastPaid, "id" | "undoable"> }) {
  if (!paid.undoable) return null;
  return (
    <button
      type="button"
      className={btnSecondarySm}
      disabled={controls.paying || controls.undoing}
      onClick={() => controls.undo(paid.id)}
      data-testid="week-pay-undo"
    >
      {controls.undoing ? "Undoing…" : "Undo"}
    </button>
  );
}

export function WeekPayError({ controls }: { controls: AvalancheWeekPayControls }) {
  if (!controls.error) return null;
  return (
    <p role="alert" className="text-label text-bad-ink" data-testid="week-pay-error">
      {controls.error}
    </p>
  );
}
