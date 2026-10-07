import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { createRequire } from "module";
// @ts-expect-error -- plain .mjs shared module, no type declarations
import { resolveBuildId } from "../../scripts/build-id.mjs";

// The per-deploy build id, resolved exactly as the classic app and the API do
// (scripts/build-id.mjs), so `__APP_VERSION__` here and `/api/version` agree
// on what "current" means after a deploy. The version prompt compares them.
const buildId: string = resolveBuildId();

const isServe =
  process.argv.includes("serve") ||
  process.argv.includes("dev") ||
  process.argv.includes("preview");

const rawPort = process.env.PORT;
if (isServe && !rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}
const port = rawPort ? Number(rawPort) : 5174;
if (rawPort && (Number.isNaN(port) || port <= 0)) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// H2 lives at the root of the origin. The classic app is the one that moved
// (to /classic/); this app only takes a BASE_PATH so a preview can mount it
// elsewhere if it ever needs to.
const basePath = process.env.BASE_PATH ?? "/";

/**
 * The webfonts the open screen paints with, preloaded so they download beside
 * the stylesheet instead of one round trip after it (a font found inside a
 * stylesheet is always late). Same approach as the classic `interPreload()`:
 * in a build, look up the file the CSS pipeline already emitted (never emit a
 * second copy); in dev, point at the package file Vite serves directly.
 *
 * Sans (every word) and mono 400 + 500 (every figure) are preloaded. The serif
 * is not: it sets headlines and section labels, swaps in when it lands, and
 * would otherwise compete with the two faces the numbers need.
 */
const PRELOADS: Array<{ placeholder: string; pkg: string; file: string }> = [
  {
    placeholder: "__FONT_SANS__",
    pkg: "@fontsource-variable/public-sans",
    file: "public-sans-latin-wght-normal.woff2",
  },
  {
    placeholder: "__FONT_MONO_400__",
    pkg: "@fontsource/ibm-plex-mono",
    file: "ibm-plex-mono-latin-400-normal.woff2",
  },
  {
    placeholder: "__FONT_MONO_500__",
    pkg: "@fontsource/ibm-plex-mono",
    file: "ibm-plex-mono-latin-500-normal.woff2",
  },
];

function fontPreload(): Plugin {
  return {
    name: "h2-font-preload",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        let out = html;
        for (const { placeholder, pkg, file } of PRELOADS) {
          let href: string | undefined;
          const stem = file.replace(/\.woff2$/, "");
          if (ctx.bundle) {
            const hit = Object.values(ctx.bundle).find(
              (a) => a.type === "asset" && a.fileName.includes(stem) && a.fileName.endsWith(".woff2"),
            );
            if (hit) href = `${basePath.replace(/\/$/, "")}/${hit.fileName}`;
          } else {
            const require = createRequire(import.meta.url);
            const pkgJson = require.resolve(`${pkg}/package.json`);
            href = `/@fs${path.join(path.dirname(pkgJson), "files", file)}`;
          }
          // A font that did not resolve drops its tag rather than shipping a
          // preload that 404s; the stylesheet still loads it, one hop later.
          out = href
            ? out.replace(placeholder, href)
            : out.replace(new RegExp(`\\n\\s*<link rel="preload" href="${placeholder}"[^>]*>`), "");
        }
        return out;
      },
    },
  };
}

export default defineConfig({
  base: basePath,
  define: {
    __APP_VERSION__: JSON.stringify(buildId),
  },
  plugins: [react(), tailwindcss(), fontPreload()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  esbuild: {
    drop: process.env.NODE_ENV === "production" ? ["debugger"] : [],
    pure:
      process.env.NODE_ENV === "production"
        ? ["console.log", "console.debug", "console.info", "console.trace"]
        : [],
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    sourcemap: false,
    // Function form, by module PATH, for the same reason as the classic app:
    // the object form drags shared dependencies into whichever chunk claims
    // them first. `scripts/check-entry-graph.mjs --dist artifacts/h2/dist/public`
    // fails the build if react-dom ever lands outside vendor-react.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/\.pnpm\/(react@|react-dom@|scheduler@|wouter@|clsx@)/.test(id)) {
            return "vendor-react";
          }
          if (id.includes("@clerk")) return "vendor-clerk";
          if (id.includes("@tanstack")) return "vendor-query";
          return undefined;
        },
      },
    },
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: { strict: true },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
