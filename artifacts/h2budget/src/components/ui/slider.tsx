import * as React from "react"
import * as SliderPrimitive from "@radix-ui/react-slider"

import { cn } from "@/lib/utils"

const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn(
      "relative flex w-full touch-none select-none items-center",
      className
    )}
    {...props}
  >
    <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-brand-line">
      <SliderPrimitive.Range className="absolute h-full bg-brand-navy" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb className="press block h-4 w-4 rounded-full bg-white shadow-rest ring-1 ring-brand-navy/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy disabled:pointer-events-none disabled:opacity-55" />
  </SliderPrimitive.Root>
))
Slider.displayName = SliderPrimitive.Root.displayName

export { Slider }
