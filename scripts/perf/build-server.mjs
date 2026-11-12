// PERF HARNESS ONLY — bundles the real API server for local timing, with `@clerk/express` replaced by
// `stubs/clerk-express.ts`. Writes to OUT (default /private/tmp/claude-501/perf/server-dist), never to
// artifacts/api-server/dist, and is never part of `pnpm run build` or the deploy.
//
//   node scripts/perf/build-server.mjs [OUT=/path]
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rm, symlink } from "node:fs/promises";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const apiDir = path.join(root, "artifacts/api-server");
const require = createRequire(path.join(apiDir, "package.json"));
globalThis.require = require;
const { build } = require("esbuild");
const pino = require("esbuild-plugin-pino");
const { resolveBuildId } = await import(path.join(root, "scripts/build-id.mjs"));

const out = process.env.OUT ?? "/private/tmp/claude-501/perf/server-dist";
await rm(out, { recursive: true, force: true });

const clerkStub = {
  name: "perf-clerk-stub",
  setup(b) {
    b.onResolve({ filter: /^@clerk\/express$/ }, () => ({ path: path.join(here, "stubs/clerk-express.ts") }));
  },
};

await build({
  entryPoints: { index: path.join(here, "server-entry.ts") },
  absWorkingDir: apiDir,
  nodePaths: [path.join(apiDir, "node_modules")],
  platform: "node",
  bundle: true,
  format: "esm",
  outdir: out,
  outExtension: { ".js": ".mjs" },
  logLevel: "warning",
  external: ["*.node", "pg-native", "@opentelemetry/*", "bufferutil", "utf-8-validate", "fsevents"],
  sourcemap: "linked",
  define: { __APP_VERSION__: JSON.stringify(resolveBuildId()) },
  plugins: [clerkStub, pino({ transports: ["pino-pretty"] })],
  banner: {
    js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';
globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
`,
  },
});
// The few external packages resolve from the API server's own node_modules.
await symlink(path.join(apiDir, "node_modules"), path.join(out, "node_modules"), "dir");
console.log(`perf server bundle → ${out}/index.mjs`);
