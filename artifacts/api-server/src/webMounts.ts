import express, { type Express } from "express";
import path from "node:path";
import { existsSync } from "node:fs";

/**
 * ⭐ TWO WEB APPS, ONE ORIGIN.
 *
 * H2 (`artifacts/h2`) is the app at `/`. The classic app
 * (`artifacts/h2budget`, built with `BASE_PATH=/classic/`) is frozen and
 * served under `/classic` until it is retired. Both are plain Vite builds; the
 * API at `/api` is untouched by either.
 *
 * Each app gets the SAME treatment the single app always had:
 *   - hashed asset files (…-[hash].js/css) cache for a year;
 *   - `index.html` is the version pointer, so it is never cached (the in-app
 *     poller compares build ids and prompts a reload after each deploy);
 *   - an SPA fallback serves `index.html` for client-side routes.
 *
 * ⚠️ ORDER IS LOAD-BEARING. Classic mounts FIRST: H2's fallback matches every
 * non-`/api` path, so registered first it would swallow `/classic/*` and
 * answer it with H2's shell. Each app is mounted only if its build exists, so
 * local dev (Vite dev servers, no build) and the API tests are untouched; with
 * no classic build, `/classic/*` falls through to H2, which renders its
 * not-found screen inside its shell.
 */
export interface WebMountDirs {
  /** H2's built `dist/public`, served at `/`. */
  webDistDir: string;
  /** The classic app's built `dist/public`, served at `/classic`. */
  classicDistDir: string;
}

export function mountWebApps(app: Express, { webDistDir, classicDistDir }: WebMountDirs): void {
  const classicIndexHtml = path.join(classicDistDir, "index.html");
  if (existsSync(classicIndexHtml)) {
    app.use(
      "/classic",
      express.static(classicDistDir, {
        index: false,
        maxAge: "1y",
        setHeaders: (res, filePath) => {
          if (filePath === classicIndexHtml) res.setHeader("Cache-Control", "no-cache");
        },
      }),
    );
    // `/classic`, `/classic/` and every client route beneath it — but not
    // `/classicfoo`, which is H2's to answer.
    app.get(/^\/classic(\/.*)?$/, (_req, res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(classicIndexHtml);
    });
  }

  const webIndexHtml = path.join(webDistDir, "index.html");
  if (existsSync(webIndexHtml)) {
    app.use(
      express.static(webDistDir, {
        index: false,
        maxAge: "1y",
        setHeaders: (res, filePath) => {
          if (filePath === webIndexHtml) res.setHeader("Cache-Control", "no-cache");
        },
      }),
    );
    // SPA fallback. The negative lookahead keeps `/api/*` out of it: those
    // must 404 as JSON, never as an HTML shell.
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(webIndexHtml);
    });
  }
}
