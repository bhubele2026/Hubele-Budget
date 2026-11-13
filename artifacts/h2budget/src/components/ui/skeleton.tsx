import { useRef } from "react"
import { cn } from "@/lib/utils"
import { useGhostExit } from "@/lib/motion"

/**
 * A `<div>` that hands over to what replaces it: when it unmounts, its picture
 * fades out over the content arriving under it (lib/motion.ts `ghostOut`)
 * instead of cutting to it. Every skeleton container is one.
 */
function GhostDiv(props: React.HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null)
  useGhostExit(ref)
  return <div ref={ref} {...props} />
}

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <GhostDiv
      // `.skeleton` (index.css) is a platinum sweep, not a pulse: a shape where
      // the content will be, so nothing moves when the data lands.
      className={cn("skeleton", className)}
      {...props}
    />
  )
}

export { GhostDiv, Skeleton }
