import { useToast } from "@/hooks/use-toast"
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast"

export function Toaster() {
  const { toasts } = useToast()

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, secondaryAction, ...props }) {
        return (
          <Toast key={id} {...props}>
            <div className="grid gap-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && (
                <ToastDescription>{description}</ToastDescription>
              )}
            </div>
            {/* One action renders exactly as it always has; two sit side by
                side (C0, `toastWithActions`). */}
            {secondaryAction ? (
              <div data-testid="toast-actions" className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                {action}
                {secondaryAction}
              </div>
            ) : (
              action
            )}
            <ToastClose />
          </Toast>
        )
      })}
      <ToastViewport />
    </ToastProvider>
  )
}
