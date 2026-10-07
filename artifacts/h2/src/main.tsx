import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/index.css";

// (Self-heal, ported from the classic app.) After a deploy the chunk file names
// change, and a tab that was already open asks for an OLD chunk that now 404s
// ("Failed to fetch dynamically imported module"). Reload ONCE to pick up the
// fresh build. A 10 s timestamp guard stops a reload loop when the import is
// genuinely broken rather than stale. The key is shared with the classic app:
// one origin, one guard.
const RELOAD_KEY = "h2:chunk-reload-at";

function reloadForStaleChunk() {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    if (Date.now() - last < 10_000) return; // just reloaded → don't loop
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    /* sessionStorage unavailable — fall through to a single reload */
  }
  window.location.reload();
}

// Vite fires this when a modulepreload / dynamic import fails.
window.addEventListener("vite:preloadError", (e) => {
  e.preventDefault();
  reloadForStaleChunk();
});

// React.lazy import() failures surface as unhandled rejections.
window.addEventListener("unhandledrejection", (e) => {
  const msg = String((e.reason && (e.reason.message ?? e.reason)) ?? "");
  if (
    /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
      msg,
    )
  ) {
    reloadForStaleChunk();
  }
});

const container = document.getElementById("root")!;

// The static boot frame in index.html lives inside #root so it paints with no
// script. Clear it before mounting: this is a client render, not a hydration.
container.replaceChildren();

createRoot(container).render(<App />);
