import * as React from "react"

import { cn } from "@/lib/utils"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          // A field is a white well with a platinum hairline; focus deepens the
          // hairline to navy rather than adding a glow.
          "flex h-9 w-full rounded-control border-0 bg-white px-3 py-2 text-body ring-1 ring-brand-line transition-[box-shadow,color] file:border-0 file:bg-transparent file:text-label file:font-medium file:text-foreground placeholder:text-neutral-400 focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy disabled:cursor-not-allowed disabled:opacity-55",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
