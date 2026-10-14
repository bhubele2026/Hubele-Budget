import {
  createElement,
  lazy,
  useState,
  type ComponentProps,
  type ComponentType,
} from "react";

/**
 * ⚠️ `lazy()` ALWAYS SUSPENDS ON ITS FIRST RENDER, EVEN WHEN THE CHUNK IS ALREADY
 * IN THE BROWSER CACHE — and once the fallback has committed, React holds the
 * retry for ~300 ms (the Suspense throttle). A page whose chunk was warmed on
 * hover or at idle still paid that wait before it painted.
 *
 * This keeps the resolved module. A component whose chunk has loaded renders
 * the page directly, with no Suspense at all; one whose chunk has not loaded
 * falls back to a normal `lazy()` (so the existing fallback still covers a
 * genuine cold load).
 *
 * The cache is keyed by the importer FUNCTION, so `routePrefetch.ts` (hover,
 * idle, module-scope warm) and `App.tsx` (the route) share one load per chunk
 * without either knowing about the other.
 */
type Mod<T> = { default: T };
type Entry<T> = { promise: Promise<Mod<T>>; mod: Mod<T> | null };

const cache = new Map<() => Promise<unknown>, Entry<ComponentType<never>>>();

/** Start (or join) the load for `importer`. A failure is forgotten so a later ask retries. */
export function preloadImporter<T>(importer: () => Promise<Mod<T>>): Promise<Mod<T>> {
  let entry = cache.get(importer) as Entry<T> | undefined;
  if (!entry) {
    const fresh: Entry<T> = { mod: null, promise: undefined as unknown as Promise<Mod<T>> };
    fresh.promise = importer().then(
      (m) => {
        fresh.mod = m;
        return m;
      },
      (e: unknown) => {
        cache.delete(importer);
        throw e;
      },
    );
    cache.set(importer, fresh as unknown as Entry<ComponentType<never>>);
    entry = fresh;
  }
  return entry.promise;
}

/** The resolved module for `importer`, or null when its chunk has not loaded yet. */
export function loadedModule<T>(importer: () => Promise<Mod<T>>): Mod<T> | null {
  return (cache.get(importer) as Entry<T> | undefined)?.mod ?? null;
}

export type PreloadableComponent<T extends ComponentType<any>> = ComponentType<ComponentProps<T>> & {
  /** Start loading the chunk. Resolves once it can render without suspending. */
  preload: () => Promise<void>;
};

export function lazyWithPreload<T extends ComponentType<any>>(
  importer: () => Promise<Mod<T>>,
): PreloadableComponent<T> {
  const Lazy = lazy(() => preloadImporter(importer));
  // Decided ONCE per mounted instance: swapping Lazy for the loaded page on a
  // later render would remount it and drop its state.
  function Preloadable(props: ComponentProps<T>) {
    const [Picked] = useState<ComponentType<any>>(() => loadedModule(importer)?.default ?? Lazy);
    return createElement(Picked, props);
  }
  Preloadable.preload = () => preloadImporter(importer).then(() => undefined);
  return Preloadable as unknown as PreloadableComponent<T>;
}
