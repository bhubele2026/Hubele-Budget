import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * (R) The checking figure has ONE presentation ("Checking today" + the calculated line). The old Reports
 * words — a "Bank balance" tile labelled "Plaid · <account>" / "Manual · <account>" — must not come back
 * in any user-facing source file.
 */
const SRC = join(__dirname, "..", "..");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "__fixture__" || n === "node_modules" ? [] : files(p);
    return /\.(ts|tsx)$/.test(n) && !/\.test\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

describe("(R) no 'Bank balance · Plaid' for the checking figure", () => {
  const all = files(SRC).map((p) => ({ p, text: readFileSync(p, "utf8") }));

  it("no Plaid/Manual · <account> label is built from the snapshot's source", () => {
    const hits = all.filter((f) => /source\s*===\s*"plaid"\s*\?\s*"Plaid"\s*:\s*"Manual"/.test(f.text) || /Bank balance · Plaid/.test(f.text)).map((f) => f.p);
    expect(hits).toEqual([]);
  });

  it("no screen labels a figure 'Bank balance'", () => {
    const hits = all.filter((f) => /label=["']Bank balance["']/.test(f.text)).map((f) => f.p);
    expect(hits).toEqual([]);
  });
});
