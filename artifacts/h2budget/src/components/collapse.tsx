import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { reducedMotion } from "@/lib/motion";
import { cssMs } from "@/lib/motion-extra";

/**
 * ⭐ (Every click glides) A row's details open and shut on the collapse glide — the height eases and the content fades
 * on `--dur-in` — instead of mounting and vanishing on the frame. Nothing moves on first paint; what it held stays on
 * screen until the close has played, then unmounts. Reduced motion: an instant swap, as before.
 */
export function Collapse({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(open);
  const kept = useRef<ReactNode>(null);
  if (open) kept.current = children;
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (open && !mounted) {
      setMounted(true);
      return;
    }
    const el = ref.current;
    if (!el || reducedMotion() || typeof el.animate !== "function") {
      if (!open) setMounted(false);
      return;
    }
    const h = el.scrollHeight;
    el.style.overflow = "hidden";
    const frames = [
      { height: "0px", opacity: 0 },
      { height: `${h}px`, opacity: 1 },
    ];
    const a = el.animate(open ? frames : frames.reverse(), { duration: cssMs("--dur-in", 240), easing: "cubic-bezier(0.22,0.61,0.36,1)" });
    a.onfinish = () => {
      el.style.overflow = "";
      if (!open) setMounted(false);
    };
    return () => a.cancel();
  }, [open, mounted]);
  if (!mounted && !open) return null;
  return (
    <div ref={ref} className={cn(className)}>
      {open ? children : kept.current}
    </div>
  );
}
