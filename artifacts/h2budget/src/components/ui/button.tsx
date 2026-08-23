import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// Flat, matte, navy. `.press` (index.css) carries the transform/colour
// transition, so every button in the app answers a click on the frame it
// happens — one edit, all of them. No gradients, no candy: the house style is
// thin marks and small corners.
const buttonVariants = cva(
  "press inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-control text-body font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-brand-navy text-white hover:bg-brand-navy2",
        // ⚠️ Deep orange #e16d3e, and the hover is a DEEPER orange — a crimson
        // hover under an orange rest state reads as two different buttons.
        destructive: "bg-bad text-white hover:bg-[#c2562a]",
        // The quiet ghost control: a hairline ring, no blue, no underline.
        outline:
          "bg-white text-neutral-700 ring-1 ring-brand-line hover:bg-neutral-50 hover:text-brand-navy",
        secondary:
          "bg-secondary text-secondary-foreground ring-1 ring-brand-line hover:bg-brand-tint",
        ghost: "text-neutral-700 hover:bg-secondary hover:text-brand-navy",
        // ⭐ NOT A LINK. Secondary actions are app controls, not hypertext.
        link: "text-brand-navy underline-offset-4 hover:underline",
      },
      size: {
        default: "min-h-9 px-3.5 py-1.5",
        sm: "min-h-8 rounded-control px-2.5 text-micro font-semibold",
        lg: "min-h-10 rounded-control px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
