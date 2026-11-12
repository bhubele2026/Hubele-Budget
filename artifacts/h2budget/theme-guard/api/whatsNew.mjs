// GET /api/whats-new/me — every note already read, so no what's-new sheet opens
// on its own. The ids are read from the notes file at start (never hard-coded),
// plus the one being added alongside this harness.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const NOTES = path.resolve(here, "../../../../lib/avalanche-core/src/whatsNew.ts");
const ALSO = ["2026-11-11.4"];

function ids() {
  let src = "";
  try {
    src = fs.readFileSync(NOTES, "utf8");
  } catch {
    // no notes file → only the extra ids
  }
  const found = [...src.matchAll(/^\s*id:\s*"([^"]+)"/gm)].map((m) => m[1]);
  return [...new Set([...found, ...ALSO])];
}

export function whatsNewMe() {
  // Read on every request: a note added while the server runs is read too.
  return { read: ids().sort().reverse(), from: "2026-01-01" };
}
