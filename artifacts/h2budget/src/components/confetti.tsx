import { useEffect, useState, type CSSProperties } from "react";

type Piece = {
  id: number;
  left: number;
  delay: number;
  dur: number;
  rot: number;
  drift: number;
  color: string;
  size: number;
};

const COLORS = ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#e5e7eb"];

/**
 * Lightweight, dependency-free confetti burst. Render it and flip `fire` to
 * true to celebrate a win (under budget, debt paid, goal hit). Self-clears
 * after the animation; honors prefers-reduced-motion (renders nothing).
 */
export function Confetti({
  fire,
  count = 90,
}: {
  fire: boolean;
  count?: number;
}) {
  const [pieces, setPieces] = useState<Piece[]>([]);

  useEffect(() => {
    if (!fire) {
      setPieces([]);
      return;
    }
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const arr: Piece[] = Array.from({ length: count }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 0.35,
      dur: 1.8 + Math.random() * 1.6,
      rot: 180 + Math.random() * 540,
      drift: (Math.random() - 0.5) * 260,
      color: COLORS[i % COLORS.length],
      size: 5 + Math.round(Math.random() * 5),
    }));
    setPieces(arr);
    const t = window.setTimeout(() => setPieces([]), 3800);
    return () => window.clearTimeout(t);
  }, [fire, count]);

  if (pieces.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-[60] overflow-hidden">
      {pieces.map((p) => (
        <span
          key={p.id}
          className="absolute top-[-12px] block rounded-[1px]"
          style={
            {
              left: `${p.left}%`,
              width: p.size,
              height: p.size,
              background: p.color,
              animation: `cc-fall ${p.dur}s linear ${p.delay}s forwards`,
              // CSS custom props consumed by the keyframe in index.css
              "--cc-drift": `${p.drift}px`,
              "--cc-rot": `${p.rot}deg`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
