"use client"

import * as React from "react"
import * as ProgressPrimitive from "@radix-ui/react-progress"

import { cn } from "@/lib/utils"

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>
>(({ className, value, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    className={cn(
      "relative h-2 w-full overflow-hidden rounded-full bg-brand-line",
      className
    )}
    {...props}
  >
    <ProgressPrimitive.Indicator
      // Travels on the shared bar timing/curve, not a blanket `transition-all`.
      // The offset below is set as an inline `transform`, so `transform` is the
      // property named here — `translate` would animate nothing.
      className="h-full w-full flex-1 bg-brand-navy transition-[transform] duration-[calc(700ms*var(--anim-speed))] ease-[var(--ease-move)]"
      style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
    />
  </ProgressPrimitive.Root>
))
Progress.displayName = ProgressPrimitive.Root.displayName

export { Progress }
