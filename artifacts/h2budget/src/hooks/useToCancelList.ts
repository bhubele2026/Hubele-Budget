import { useCallback, useEffect, useState } from "react";

/**
 * "To cancel" list — a lightweight, client-only shortlist of subscriptions
 * the user has flagged to cancel, with a check-off once they've actually
 * done it. Persisted in localStorage (no backend table needed) and shared
 * across every component on the page via a same-tab change event, so the
 * "To cancel" buttons on the subscription rows and the "To cancel" bucket
 * card stay in lockstep.
 */
export type ToCancelItem = {
  /** Stable identity — `detected:<merchant>-<cadence>` or `sub:<id>`. */
  key: string;
  name: string;
  monthly: number;
  annual: number;
  /** ISO timestamp of when it was added to the list. */
  markedAt: string;
  /** Ticked off once the user has actually cancelled it. */
  cancelled: boolean;
};

const STORAGE_KEY = "h2:to-cancel:v1";
const CHANGE_EVENT = "h2:to-cancel:changed";

function read(): ToCancelItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ToCancelItem[]) : [];
  } catch {
    return [];
  }
}

export function useToCancelList() {
  const [items, setItems] = useState<ToCancelItem[]>(() => read());

  // Keep every hook instance in sync — both across tabs (native `storage`
  // event) and within the same tab (our custom event, since `storage` does
  // not fire in the tab that made the change).
  useEffect(() => {
    const sync = () => setItems(read());
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) sync();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(CHANGE_EVENT, sync);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(CHANGE_EVENT, sync);
    };
  }, []);

  const persist = useCallback((next: ToCancelItem[]) => {
    setItems(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore quota / private-mode errors */
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  const add = useCallback(
    (item: Pick<ToCancelItem, "key" | "name" | "monthly" | "annual">) => {
      const cur = read();
      if (cur.some((i) => i.key === item.key)) return;
      persist([
        ...cur,
        { ...item, markedAt: new Date().toISOString(), cancelled: false },
      ]);
    },
    [persist],
  );

  const remove = useCallback(
    (key: string) => persist(read().filter((i) => i.key !== key)),
    [persist],
  );

  const toggleCancelled = useCallback(
    (key: string) =>
      persist(
        read().map((i) =>
          i.key === key ? { ...i, cancelled: !i.cancelled } : i,
        ),
      ),
    [persist],
  );

  const has = useCallback(
    (key: string) => items.some((i) => i.key === key),
    [items],
  );

  return { items, add, remove, toggleCancelled, has };
}
