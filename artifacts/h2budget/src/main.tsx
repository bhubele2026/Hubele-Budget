import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// (Self-heal) After a deploy the JS chunk filenames change; an already-open tab
// still asks for an OLD chunk that now 404s ("Failed to fetch dynamically
// imported module"). Auto-reload ONCE to pull the fresh build so the user never
// sees a stale-chunk error. A 10s timestamp guard prevents a reload loop if the
// import is genuinely broken (not just stale), while still self-healing future
// deploys.
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

// Vite fires this when a <link rel="modulepreload"> / dynamic import fails.
window.addEventListener("vite:preloadError", (e) => {
  e.preventDefault();
  reloadForStaleChunk();
});

// React.lazy import() failures surface as unhandled rejections.
window.addEventListener("unhandledrejection", (e) => {
  const msg = String(
    (e.reason && (e.reason.message ?? e.reason)) ?? "",
  );
  if (
    /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
      msg,
    )
  ) {
    reloadForStaleChunk();
  }
});

createRoot(document.getElementById("root")!).render(<App />);
