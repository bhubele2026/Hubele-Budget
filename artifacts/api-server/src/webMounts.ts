import express, { type Express } from "express";
import path from "node:path";
import { existsSync } from "node:fs";

/**
 * ⭐ ONE WEB APP, ONE ORIGIN (the switch, 2026-10-09).
 *
 * `artifacts/h2budget` — the app — is built with `BASE_PATH=/` and served at
 * `/`. The API at `/api` is untouched by it. The interim H2 app is deleted;
 * the address the app had while it was previewed, `/classic`, now redirects.
 *
 *   - `/classic`, `/classic/` and `/classic/<path>` → 301 to `/<path>` (`/` for
 *     the bare forms), the query string kept — every bookmark and every link
 *     from that time still lands. Registered first, and even without a build.
 *   - Hashed asset files (…-[hash].js/css) cache for a year.
 *   - `index.html` is the version pointer, so it is never cached (the in-app
 *     poller compares build ids and prompts a reload after each deploy).
 *   - A missing `/assets/*` file is a plain 404, never the HTML shell: a tab
 *     left open across a deploy asks for an old chunk, and an HTML answer to a
 *     module request only muddies the reload-once self-heal in `main.tsx`.
 *   - The SPA fallback serves `index.html` for every client route — including
 *     `/plaid-oauth?oauth_state_id=…`, Plaid's registered redirect URI, which
 *     must be answered in place (no redirect) so the OAuth state round-trips.
 *     `/api` and `/api/*` are never answered with HTML.
 *
 * Without a build (local dev on the Vite server, the API tests) only the
 * `/classic` redirect is mounted.
 */
export interface WebMountOptions {
  /** The app's built `dist/public`, served at `/`. */
  distDir: string;
}

export function mountWebApp(app: Express, { distDir }: WebMountOptions): void {
  // `/classic` and everything beneath it — but not `/classicfoo`.
  app.get(/^\/classic(?:\/.*)?$/, (req, res) => {
    const q = req.originalUrl.indexOf("?");
    const search = q === -1 ? "" : req.originalUrl.slice(q);
    // One leading slash, always: `/classic//evil.example` (or `/classic/\evil…`,
    // which browsers read as `//`) must not become a protocol-relative URL —
    // an open redirect.
    const rest = req.path.replace(/^\/classic/, "").replace(/^[/\\]+/, "/");
    res.redirect(301, `${rest === "" ? "/" : rest}${search}`);
  });

  const indexHtml = path.join(distDir, "index.html");
  if (!existsSync(indexHtml)) return;

  app.use(
    express.static(distDir, {
      index: false,
      maxAge: "1y",
      setHeaders: (res, filePath) => {
        if (filePath === indexHtml) res.setHeader("Cache-Control", "no-cache");
      },
    }),
  );
  // A hashed file this build does not have: 404, not the shell.
  app.get(/^\/assets\//, (_req, res) => {
    res.status(404).type("text/plain").send("Not found");
  });
  // SPA fallback. The negative lookahead keeps `/api` and `/api/*` out of it:
  // those must 404 as JSON, never as an HTML shell.
  app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(indexHtml);
  });
}

/**
 * Where the built app is. `WEB_DIST_DIR` overrides the default (the sibling
 * `artifacts/h2budget/dist/public`) only when it holds a build: before the
 * switch it pointed at the interim app's build, which no longer exists, and a
 * stale value left in the host's environment must not leave `/` blank.
 */
export function resolveWebDistDir(
  fromEnv: string | undefined,
  defaultDir: string,
  warn: (msg: string) => void = () => {},
): string {
  const env = fromEnv?.trim();
  if (!env) return defaultDir;
  if (existsSync(path.join(env, "index.html"))) return env;
  warn(`WEB_DIST_DIR=${env} has no index.html; serving ${defaultDir} instead`);
  return defaultDir;
}
