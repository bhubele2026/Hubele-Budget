import { cn } from "@/lib/utils"

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      // `.skeleton` (index.css) is a platinum sweep, not a pulse: a shape where
      // the content will be, so nothing moves when the data lands.
      className={cn("skeleton", className)}
      {...props}
    />
  )
}

export { Skeleton }
