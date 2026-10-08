import type { ReactNode } from "react"
import { toast } from "@/hooks/use-toast"
import { ToastAction } from "@/components/ui/toast"

export type ToastButton = {
  label: string
  onClick: () => void
  /** What a screen reader announces for the button; defaults to the label. */
  altText?: string
  "data-testid"?: string
}

/**
 * (C0) A toast with one or two actions — the review queue's "Undo" beside
 * "Apply to 12 similar" (parity review F1). The classic `toast()` takes a
 * single `action`; this builds both buttons the same way and puts the second
 * in `secondaryAction`, which the Toaster lays out beside the first. Each
 * button closes the toast (a Radix `Toast.Action`) and runs its handler.
 */
export function toastWithActions(opts: {
  title?: ReactNode
  description?: ReactNode
  variant?: "default" | "destructive"
  duration?: number
  actions: readonly [ToastButton] | readonly [ToastButton, ToastButton]
}) {
  const [first, second] = opts.actions
  const button = (a: ToastButton) => (
    <ToastAction altText={a.altText ?? a.label} onClick={a.onClick} data-testid={a["data-testid"]}>
      {a.label}
    </ToastAction>
  )
  return toast({
    title: opts.title,
    description: opts.description,
    variant: opts.variant,
    duration: opts.duration,
    action: button(first),
    secondaryAction: second ? button(second) : undefined,
  })
}
