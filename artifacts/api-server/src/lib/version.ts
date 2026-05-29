// Per-deploy build identifier. `__APP_VERSION__` is replaced at build
// time by esbuild's `define` (see build.mjs) with the git short hash
// (or a build timestamp fallback). When the bundle is run without that
// define — e.g. tsc typecheck or an unbundled dev path — we fall back to
// "dev" so the value is always a non-empty string. The web bundle bakes
// the SAME identifier at build time so the client can detect a new
// deploy by comparing the two.
declare const __APP_VERSION__: string | undefined;

export const APP_VERSION: string =
  typeof __APP_VERSION__ !== "undefined" && __APP_VERSION__
    ? __APP_VERSION__
    : "dev";
