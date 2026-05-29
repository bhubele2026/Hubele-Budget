// (#823) Per-deploy build identifier baked into the loaded web bundle.
// `__APP_VERSION__` is replaced at build time by Vite's `define` (see
// vite.config.ts) with the git short hash (or a build-timestamp
// fallback). The API server stamps the SAME identifier into its bundle
// and serves it at GET /api/version, so the client can detect a new
// deploy by comparing the two. When the define is absent (e.g. a tooling
// path that didn't run the Vite build) we fall back to "dev".
declare const __APP_VERSION__: string | undefined;

export const APP_VERSION: string =
  typeof __APP_VERSION__ !== "undefined" && __APP_VERSION__
    ? __APP_VERSION__
    : "dev";
