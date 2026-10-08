import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "./Button";

export interface ToastAction {
  label: string;
  onPress: () => void | Promise<void>;
}

export interface ToastInput {
  message: string;
  actions?: ToastAction[];
  /** An error reads as an alert and stays a little longer. */
  tone?: "info" | "error";
}

interface ToastItem extends ToastInput {
  id: number;
}

interface ToastApi {
  show: (t: ToastInput) => number;
  dismiss: (id: number) => void;
}

const Ctx = createContext<ToastApi | null>(null);

/**
 * Short notices with an optional action ("Undo"). A few lines on the paper,
 * ruled, no shadow and no motion. They stand clear of the phone's dock and its
 * safe-area inset, and go by themselves after eight seconds (a quiet one,
 * five). Only the Activity screens mount the provider.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setItems((xs) => xs.filter((x) => x.id !== id));
  }, []);

  const show = useCallback(
    (t: ToastInput) => {
      const id = next.current++;
      setItems((xs) => [...xs.slice(-2), { ...t, id }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), t.actions?.length || t.tone === "error" ? 8000 : 5000),
      );
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const live = timers.current;
    return () => {
      for (const t of live.values()) clearTimeout(t);
      live.clear();
    };
  }, []);

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div
        aria-label="Notices"
        className="pointer-events-none fixed inset-x-4 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-[60] flex flex-col gap-2 md:inset-x-auto md:right-6 md:bottom-6 md:w-96"
        data-testid="toasts"
      >
        {items.map((t) => (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            className="pointer-events-auto flex flex-col gap-2 rounded-2 border border-rule-strong bg-paper-0 px-4 py-3"
            data-testid="toast"
          >
            <p className="type-body text-ink">{t.message}</p>
            {t.actions && t.actions.length > 0 && (
              <div className="flex flex-wrap items-center gap-3">
                {t.actions.map((a) => (
                  <Button
                    key={a.label}
                    variant="link"
                    size="sm"
                    onClick={() => {
                      dismiss(t.id);
                      void a.onPress();
                    }}
                  >
                    {a.label}
                  </Button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(Ctx);
  if (!api) throw new Error("useToast outside ToastProvider");
  return api;
}
