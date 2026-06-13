import { useEffect, useRef, useState } from "react";
import { Ban, X, Check, GripVertical, ChevronDown } from "lucide-react";
import { useToCancelList } from "@/hooks/useToCancelList";
import { cn, formatCurrency } from "@/lib/utils";

const POS_KEY = "h2:cancel-floater-pos:v1";

/**
 * A persistent, draggable floating panel of everything flagged "to cancel".
 * It stays on screen (over every page) until each item is checked off or
 * removed — a relentless nag to actually kill the recurring charges. Drag it
 * anywhere by the grip; the position is remembered.
 */
export function CancelFloater() {
  const toCancel = useToCancelList();
  const active = toCancel.items.filter((i) => !i.cancelled);

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ ox: number; oy: number; sx: number; sy: number } | null>(
    null,
  );
  const moved = useRef(false);

  // Initial position — restore the saved spot, else bottom-right.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (raw) {
        setPos(JSON.parse(raw));
        return;
      }
    } catch {
      /* ignore */
    }
    setPos({
      x: Math.max(8, window.innerWidth - 230),
      y: Math.max(8, window.innerHeight - 150),
    });
  }, []);

  const clamp = (x: number, y: number) => ({
    x: Math.max(8, Math.min(window.innerWidth - 56, x)),
    y: Math.max(8, Math.min(window.innerHeight - 56, y)),
  });

  const onPointerDown = (e: React.PointerEvent) => {
    if (!pos) return;
    moved.current = false;
    drag.current = { ox: pos.x, oy: pos.y, sx: e.clientX, sy: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const d = drag.current;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 4) moved.current = true;
    setPos(clamp(d.ox + dx, d.oy + dy));
  };
  const onPointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    setPos((p) => {
      if (p) {
        try {
          localStorage.setItem(POS_KEY, JSON.stringify(p));
        } catch {
          /* ignore */
        }
      }
      return p;
    });
  };

  if (active.length === 0 || !pos) return null;

  const totalAnnual = active.reduce((s, i) => s + i.annual, 0);

  return (
    <div
      className="fixed z-40 select-none touch-none"
      style={{ left: pos.x, top: pos.y }}
      data-testid="cancel-floater"
    >
      {open ? (
        <div className="w-72 max-w-[calc(100vw-1rem)] rounded-xl border-2 border-amber-400 bg-card shadow-2xl overflow-hidden">
          <div
            className="flex items-center gap-2 bg-amber-100 dark:bg-amber-950/50 px-3 py-2 cursor-grab active:cursor-grabbing"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          >
            <GripVertical className="w-4 h-4 text-amber-700/70 shrink-0" />
            <Ban className="w-4 h-4 text-amber-800 dark:text-amber-300 shrink-0" />
            <span className="font-bold text-amber-900 dark:text-amber-200 text-sm flex-1">
              Cancel this shit
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-amber-800 dark:text-amber-300 hover:opacity-70"
              aria-label="Minimize"
            >
              <ChevronDown className="w-4 h-4" />
            </button>
          </div>

          <div className="max-h-72 overflow-auto divide-y divide-border">
            {active.map((i) => (
              <div
                key={i.key}
                className="flex items-center gap-2.5 px-3 py-2"
                data-testid={`cancel-floater-item-${i.key}`}
              >
                <button
                  type="button"
                  onClick={() => toCancel.toggleCancelled(i.key)}
                  title="Mark cancelled"
                  className="group h-5 w-5 shrink-0 rounded border border-input hover:border-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 flex items-center justify-center transition-colors"
                >
                  <Check className="w-3.5 h-3.5 text-emerald-600 opacity-0 group-hover:opacity-100" />
                </button>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{i.name}</div>
                  <div className="text-xs text-muted-foreground tabular-nums">
                    {formatCurrency(i.monthly)}/mo · {formatCurrency(i.annual)}/yr
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => toCancel.remove(i.key)}
                  title="Remove from list"
                  className="text-muted-foreground hover:text-foreground shrink-0"
                  aria-label="Remove"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>

          <div className="px-3 py-2 text-xs text-muted-foreground border-t bg-muted/30">
            {active.length} to kill · {formatCurrency(totalAnnual)}/yr at stake
          </div>
        </div>
      ) : (
        <button
          type="button"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onClick={() => {
            if (!moved.current) setOpen(true);
          }}
          className={cn(
            "flex items-center gap-2 rounded-full border-2 border-amber-400 bg-amber-100 dark:bg-amber-950/70 text-amber-900 dark:text-amber-200 shadow-2xl px-4 py-2.5",
            "cursor-grab active:cursor-grabbing hover:bg-amber-200 dark:hover:bg-amber-900 transition-colors",
          )}
          data-testid="cancel-floater-fab"
        >
          <Ban className="w-4 h-4" />
          <span className="font-bold text-sm">Cancel ({active.length})</span>
        </button>
      )}
    </div>
  );
}
