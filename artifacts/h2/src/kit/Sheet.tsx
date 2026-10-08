import type { ReactNode, RefObject } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { buttonClass } from "./Button";

/**
 * ⭐ THE SHEET — the one overlay in the app. Up from the bottom on a phone, in
 * from the right on a desktop; the slide is on the `--dur-base` dial.
 *
 * Radix Dialog gives the hard parts: focus is trapped inside while open, and
 * Escape (or the close button, or the scrim) closes it and RETURNS FOCUS to
 * whatever opened it. No elevation: the panel sits on a scrim, edged by a rule.
 */
export function Sheet({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  returnFocusRef,
  children,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The control that opens it; focus returns here on close. */
  trigger?: ReactNode;
  title: string;
  description?: string;
  /** Where focus goes on close when there is no `trigger` (a lazy sheet opened from a control already on screen). */
  returnFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>}
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-scrim fixed inset-0 z-40 bg-ink/30" />
        <Dialog.Content
          className="sheet-panel fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-3 border-t border-rule bg-paper-0 text-ink md:inset-y-0 md:right-0 md:left-auto md:h-dvh md:max-h-none md:w-[420px] md:rounded-none md:border-t-0 md:border-l"
          {...(description ? {} : { "aria-describedby": undefined })}
          onCloseAutoFocus={(event) => {
            if (!returnFocusRef) return;
            event.preventDefault();
            returnFocusRef.current?.focus();
          }}
        >
          <div className="flex items-start justify-between gap-4 border-b border-rule px-4 pt-4 pb-3">
            <div className="min-w-0">
              <Dialog.Title className="type-headline text-ink">{title}</Dialog.Title>
              {description && (
                <Dialog.Description className="mt-1 type-caption text-ink-2">{description}</Dialog.Description>
              )}
            </div>
            <Dialog.Close className={buttonClass({ variant: "quiet", size: "sm" })} aria-label="Close">
              <X size={16} strokeWidth={1.75} aria-hidden />
            </Dialog.Close>
          </div>
          <div className="overflow-y-auto px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
