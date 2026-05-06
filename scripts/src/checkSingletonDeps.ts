#!/usr/bin/env tsx
/**
 * Fails when more than one resolved version exists for any package in the
 * singleton allowlist. This catches transitive-dep drift (e.g. a peer pulling
 * a second copy of `@types/react`) at install/CI time, before it surfaces as
 * a confusing TS2322 error deep inside a component.
 *
 * Run from the repo root: `tsx scripts/src/checkSingletonDeps.ts`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SINGLETONS = [
  "@types/react",
  "@types/react-dom",
  "react",
  "react-dom",
  "vite",
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");
const LOCKFILE = resolve(REPO_ROOT, "pnpm-lock.yaml");

function loadPackagesSection(): string {
  const text = readFileSync(LOCKFILE, "utf8");
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === "packages:");
  if (start === -1) {
    throw new Error(`Could not find 'packages:' section in ${LOCKFILE}`);
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    // Top-level key (no indent and ends with ':') marks the next section.
    if (/^[A-Za-z_]/.test(l) && l.trimEnd().endsWith(":")) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

function findVersions(packagesSection: string, name: string): Set<string> {
  // Lockfile entries look like:
  //   react@19.1.0:
  //   '@types/react@19.2.14':
  //   vite@7.3.2(@types/node@25.3.5)(...):
  // We only consider lines indented by exactly two spaces (the package keys),
  // so we don't accidentally match nested peer-spec text.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `^  '?${escaped}@([^'()\\s:]+)('?(?:\\([^\\n]*\\))?:)$`,
    "gm",
  );
  const versions = new Set<string>();
  for (const m of packagesSection.matchAll(re)) {
    versions.add(m[1]!);
  }
  return versions;
}

function main(): void {
  const packagesSection = loadPackagesSection();
  const drift: { name: string; versions: string[] }[] = [];
  const ok: { name: string; version: string | null }[] = [];

  for (const name of SINGLETONS) {
    const versions = [...findVersions(packagesSection, name)].sort();
    if (versions.length > 1) {
      drift.push({ name, versions });
    } else {
      ok.push({ name, version: versions[0] ?? null });
    }
  }

  for (const entry of ok) {
    if (entry.version === null) {
      console.log(`  • ${entry.name}: not installed`);
    } else {
      console.log(`  ✓ ${entry.name}@${entry.version}`);
    }
  }

  if (drift.length > 0) {
    console.error("");
    console.error(
      "✗ Singleton dependency drift detected. The following packages MUST",
    );
    console.error(
      "  resolve to a single version across the workspace, but multiple",
    );
    console.error("  copies are present in pnpm-lock.yaml:");
    console.error("");
    for (const { name, versions } of drift) {
      console.error(`    ${name}:`);
      for (const v of versions) {
        console.error(`      - ${v}`);
      }
    }
    console.error("");
    console.error(
      "  Fix by adding/updating an entry in the `overrides` block of",
    );
    console.error(
      "  pnpm-workspace.yaml to pin a single version, then re-run `pnpm install`.",
    );
    console.error("");
    console.error("  To inspect who pulls a second copy in:");
    for (const { name } of drift) {
      console.error(`    pnpm why -r ${name}`);
    }
    process.exit(1);
  }

  console.log("");
  console.log("✓ All singleton dependencies resolve to a single version.");
}

main();
