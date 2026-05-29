// (#833) Single source of truth for the per-deploy build identifier
// that powers the "a new version is available — Reload" prompt (#823).
//
// Background: the API bundle and the web bundle each bake a build id at
// build time. The client compares the id it booted with against the id
// the API serves at GET /api/version and prompts a reload when they
// differ. For that comparison to ever fire, BOTH bundles must bake the
// SAME real id on a given deploy.
//
// The catch (#833): the two artifacts build in SEPARATE processes, and
// in a deploy environment git may be unavailable. Previously each build
// independently resolved `git short hash → "dev"`, so when git was
// missing both fell back to "dev" and the prompt silently never fired
// (users kept having to hard-refresh). We can't fix this with an env var
// alone because an env var exported in one build process does not
// propagate to the other.
//
// Fix: a single repo-root pre-build hook (`.replit` [deployment.build])
// runs `node scripts/build-id.mjs --write` ONCE before either artifact
// builds. It resolves one real id (env → git → deploy timestamp; never
// "dev") and persists it to `.app-build-id` at the repo root. Both
// per-bundle builds then read that shared file, guaranteeing they agree
// on the id even when git is gone — because the value was resolved a
// single time, not independently per process.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The shared id file written by the deploy pre-build hook. Lives at the
// repo root so both artifact builds resolve it from the same place.
export const BUILD_ID_FILE = path.join(repoRoot, ".app-build-id");

function fromGit() {
  try {
    const out = execSync("git rev-parse --short HEAD", {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

function fromFile() {
  try {
    if (existsSync(BUILD_ID_FILE)) {
      const v = readFileSync(BUILD_ID_FILE, "utf8").trim();
      return v || null;
    }
  } catch {
    // unreadable file → treat as absent
  }
  return null;
}

// Resolution used by the per-bundle builds (api-server/build.mjs and
// h2budget/vite.config.ts). Order:
//   1. APP_BUILD_ID env — explicit pin (a pipeline can set ONE shared id).
//   2. .app-build-id file — written once by the deploy pre-build hook;
//      this is what makes the API and web bundles agree even with no git.
//   3. git short hash — the local-dev / git-available path.
//   4. "dev" — shared, non-actionable fallback. The client ignores "dev"
//      so the version check simply no-ops (the safe failure mode).
export function resolveBuildId() {
  if (process.env.APP_BUILD_ID) return process.env.APP_BUILD_ID;
  return fromFile() ?? fromGit() ?? "dev";
}

// Produce + persist the shared build id. Run from each artifact's
// `prebuild` lifecycle script so BOTH builds resolve the same value.
//
// The two artifacts can build in separate, possibly CONCURRENT processes
// (e.g. `pnpm -r run build` runs packages in parallel), so coordination
// has to be race-safe. They agree through the .app-build-id file
// (gitignored, so a fresh deploy checkout always starts without it):
//   * Deterministic source (APP_BUILD_ID env or git short hash): every
//     process computes the IDENTICAL value, so overwriting is safe — the
//     file ends up with that one value no matter the order, and it stays
//     fresh across deploys.
//   * Non-deterministic fallback (deploy timestamp, used only when there
//     is no env and no git): each process would mint a DIFFERENT
//     timestamp, so we must pick exactly one. We do an atomic
//     exclusive-create (`wx`): the first process to create the file wins;
//     any concurrent loser gets EEXIST and reads back the winner's value.
//     This closes the read-then-write race a plain "write if absent"
//     would leave open under parallel builds.
// Never writes "dev": the goal is to guarantee a real, matching id even
// when git is unavailable at build time (#833).
export function writeBuildId() {
  const deterministic = process.env.APP_BUILD_ID || fromGit();
  if (deterministic) {
    writeFileSync(BUILD_ID_FILE, `${deterministic}\n`, "utf8");
    return deterministic;
  }
  const ts = `deploy-${Date.now()}`;
  try {
    // `wx`: fail if the file already exists, so only one racing process
    // can win the create.
    writeFileSync(BUILD_ID_FILE, `${ts}\n`, { encoding: "utf8", flag: "wx" });
    return ts;
  } catch (err) {
    if (err && err.code === "EEXIST") {
      const existing = fromFile();
      if (existing) return existing;
    }
    throw err;
  }
}

// CLI: `node scripts/build-id.mjs --write` resolves + persists the id to
// .app-build-id so the subsequent build picks it up. Prints the id so
// it's visible in deploy build logs.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const id = process.argv.includes("--write") ? writeBuildId() : resolveBuildId();
  process.stdout.write(`${id}\n`);
}
