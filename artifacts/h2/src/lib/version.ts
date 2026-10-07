// The build id baked into this bundle by Vite's `define` (vite.config.ts),
// resolved by scripts/build-id.mjs exactly as the API resolves the one it
// serves at /api/version. "dev" when the define is absent (tests, tooling):
// the version prompt ignores "dev", which is the safe failure mode.
declare const __APP_VERSION__: string | undefined;

export const APP_VERSION: string =
  typeof __APP_VERSION__ !== "undefined" && __APP_VERSION__ ? __APP_VERSION__ : "dev";
