import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// `.chip` geometry (index.css): a pill, 10px, uppercase, tracked out. The
// LABEL says the state — colour only reinforces it, because under the navy
// palette `ok` is the same navy as body text and can no longer carry meaning
// on its own.
const badgeVariants = cva(
  "chip inline-flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
  {
    variants: {
      variant: {
        default: "bg-brand-navy text-white",
        secondary: "info",
        destructive: "bad",
        outline: "bg-transparent text-neutral-600 ring-1 ring-brand-line",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
