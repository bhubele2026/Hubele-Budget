import { useCallback, useEffect, useRef, useState } from "react";

/**
 * (P4) True once the element is within `margin` of the viewport, and stays true.
 * Used to start a heavy read (a chart's 12-month pull) only when its chart is
 * about to be seen. A browser without IntersectionObserver is "near" at once,
 * so nothing is ever held back for good.
 */
export function useNearViewport<T extends Element = HTMLDivElement>(margin = "400px") {
  const [near, setNear] = useState(false);
  const nodeRef = useRef<T | null>(null);
  const ioRef = useRef<IntersectionObserver | null>(null);

  const ref = useCallback(
    (node: T | null) => {
      ioRef.current?.disconnect();
      ioRef.current = null;
      nodeRef.current = node;
      if (!node) return;
      if (typeof IntersectionObserver === "undefined") {
        setNear(true);
        return;
      }
      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            setNear(true);
            io.disconnect();
          }
        },
        { rootMargin: margin },
      );
      io.observe(node);
      ioRef.current = io;
    },
    [margin],
  );

  useEffect(() => () => ioRef.current?.disconnect(), []);
  return [ref, near] as const;
}
