import { useEffect, useRef, useState } from "react";
import { Ban, X, Check, GripVertical, Minus } from "lucide-react";
import { useToCancelList } from "@/hooks/useToCancelList";
import { cn, formatCurrency } from "@/lib/utils";

const POS_KEY = "h2:cancel-floater-pos:v1";

// Angry-as-fuck, matte-black + blood-red floating hit-list of everything
// flagged "to cancel". Stays on screen (over every page) until each item is
// checked off or removed — a relentless nag to actually kill the recurring
// charges. Drag it by the grip; minimize it to the red pill with the – button;
// the position is remembered.

// Hard-coded dark/red palette (not theme-tokened) so it looks equally angry
// whether the app is in light or matte-black mode.
const RED = "hsl(0 82% 52%)"; // border / accents
const RED_BAR = "hsl(0 72% 44%)"; // header + pill fill
const PANEL = "hsl(240 9% 7%)"; // matte-black body

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

  // Always on screen — you said you always need to see it, so it stays put
  // even when nothing is flagged yet (it just nudges you to flag something).
  if (!pos) return null;

  const isEmpty = active.length === 0;
  const totalAnnual = active.reduce((s, i) => s + i.annual, 0);

  return (
    <div
      className="fixed z-40 select-none touch-none"
      style={{ left: pos.x, top: pos.y }}
      data-testid="cancel-floater"
    >
      {open ? (
        <div
          className="w-72 max-w-[calc(100vw-1rem)] rounded-md shadow-2xl overflow-hidden"
          style={{ background: PANEL, border: `2px solid ${RED}` }}
        >
          <div
            className="flex items-center gap-2 px-3 py-2 cursor-grab active:cursor-grabbing"
            style={{ background: RED_BAR }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          >
            <GripVertical className="w-4 h-4 text-white/60 shrink-0" />
            <Ban className="w-4 h-4 text-white shrink-0 animate-pulse" />
            <span className="font-extrabold uppercase tracking-wide text-white text-sm flex-1 drop-shadow">
              Cancel this shit
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="grid place-items-center h-6 w-6 rounded bg-black/20 text-white hover:bg-black/40 transition-colors"
              title="Minimize"
              aria-label="Minimize"
              data-testid="cancel-floater-minimize"
            >
              <Minus className="w-4 h-4" />
            </button>
          </div>

          <div className="max-h-72 overflow-auto">
            {isEmpty ? (
              <div className="px-4 py-6 text-center text-sm text-white/55">
                Nothing flagged yet. See a charge you&apos;d rather not keep
                paying for? Tap{" "}
                <span className="font-bold uppercase text-[hsl(0_82%_62%)]">
                  To cancel
                </span>{" "}
                on it — let&apos;s trim the fat and free up a little more for{" "}
                <span className="italic text-white/80">us</span>. 😏
              </div>
            ) : (
              <div className="divide-y divide-white/10">
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
                      className="group h-5 w-5 shrink-0 rounded border border-white/25 hover:border-[hsl(0_82%_55%)] hover:bg-[hsl(0_70%_45%)]/25 flex items-center justify-center transition-colors"
                    >
                      <Check className="w-3.5 h-3.5 text-[hsl(0_82%_62%)] opacity-0 group-hover:opacity-100" />
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-white truncate">
                        {i.name}
                      </div>
                      <div className="text-xs text-white/50 tabular-nums">
                        {formatCurrency(i.monthly)}/mo ·{" "}
                        {formatCurrency(i.annual)}/yr
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => toCancel.remove(i.key)}
                      title="Remove from list"
                      className="text-white/40 hover:text-white shrink-0 transition-colors"
                      aria-label="Remove"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div
            className="px-3 py-2 text-[11px] font-bold uppercase tracking-wide border-t border-white/10"
            style={{ background: "rgba(0,0,0,0.35)" }}
          >
            {isEmpty ? (
              <span className="text-white/50">Flag a charge to start 😈</span>
            ) : (
              <span className="text-[hsl(0_82%_64%)]">
                {active.length} to kill · {formatCurrency(totalAnnual)}/yr —
                that&apos;s more for date night 😉
              </span>
            )}
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
          className="relative grid place-items-center h-12 w-12 rounded-full text-white shadow-2xl cursor-grab active:cursor-grabbing transition-transform hover:scale-110"
          style={{ background: RED_BAR, border: `2px solid ${RED}` }}
          title="Cancel this shit"
          data-testid="cancel-floater-fab"
        >
          <Ban className="w-5 h-5 animate-pulse" />
          {active.length > 0 && (
            <span
              className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 grid place-items-center rounded-full text-[10px] font-bold text-white"
              style={{ background: "hsl(240 9% 7%)", border: `1px solid ${RED}` }}
            >
              {active.length}
            </span>
          )}
        </button>
      )}
    </div>
  );
}
