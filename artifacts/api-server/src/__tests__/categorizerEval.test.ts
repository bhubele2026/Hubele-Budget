// (PR-A) Synthetic eval of the deterministic stages (locked → heuristic).
// precision ≥ 0.97 on the rows they decide (auto + provisional write a
// category); "queue rather than wrong" ≥ 0.95 over every labelled row.
import { describe, it, expect } from "vitest";
import { decideRow } from "../lib/categorizer/decide";
import { bandFor } from "../lib/categorizer/bands";
import { catName, EVAL_CASES, evalContext } from "./_fixtures/categorizationEval";

describe("categorizer eval (synthetic)", () => {
  it("decides precisely and queues rather than guessing", () => {
    const ctx = evalContext();
    const confusion = new Map<string, Map<string, number>>();
    let decided = 0;
    let correct = 0;
    let wrong = 0;
    let filledAuto = 0;
    let filledProvisional = 0;
    let queued = 0;
    let untouched = 0;
    const nullBefore = EVAL_CASES.filter((c) => c.row.categoryId == null).length;
    const misses: string[] = [];
    for (const k of EVAL_CASES) {
      const res = decideRow(k.row, ctx);
      const band = res ? (res.source === "locked" ? "auto" : bandFor(res.confidence)) : null;
      const writes = !!res && band !== "queue" && res.categoryId != null;
      const predicted = writes ? catName(res!.categoryId) : res ? "QUEUE" : "—";
      if (writes) {
        decided += 1;
        if (predicted === k.label) correct += 1;
        else {
          wrong += 1;
          misses.push(`${k.kind}: ${k.row.description} → ${predicted} (label ${k.label})`);
        }
        if (k.row.categoryId == null) {
          if (band === "auto") filledAuto += 1;
          else filledProvisional += 1;
        }
      } else if (res) queued += 1;
      else untouched += 1;
      const lab = k.label ?? "(none)";
      const row = confusion.get(lab) ?? new Map<string, number>();
      row.set(predicted!, (row.get(predicted!) ?? 0) + 1);
      confusion.set(lab, row);
      // Injection text never steers a filing into Income.
      if (k.kind === "injection") expect(predicted).not.toBe("Income");
      // Transfers and card payments are never auto-filed.
      if (k.label === null) expect(writes).toBe(false);
    }
    const precision = correct / decided;
    const queueRatherThanWrong = (EVAL_CASES.length - wrong) / EVAL_CASES.length;
    const table = [...confusion.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, preds]) => `${label.padEnd(14)} ${[...preds.entries()].map(([p, n]) => `${p}:${n}`).join("  ")}`)
      .join("\n");
    console.log(
      `\n[categorizer eval] rows=${EVAL_CASES.length} decided=${decided} correct=${correct} wrong=${wrong} ` +
        `precision=${precision.toFixed(3)} queueRatherThanWrong=${queueRatherThanWrong.toFixed(3)}\n` +
        `[categorizer eval] uncategorized before=${nullBefore} filled auto=${filledAuto} filled provisional=${filledProvisional} ` +
        `queued=${queued} untouched=${untouched}\n` +
        `[categorizer eval] misses: ${misses.join(" | ") || "none"}\n` +
        `[categorizer eval] confusion (label → predicted:count)\n${table}\n`,
    );
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(60);
    expect(EVAL_CASES.filter((k) => k.kind === "injection")).toHaveLength(5);
    expect(precision).toBeGreaterThanOrEqual(0.97);
    expect(queueRatherThanWrong).toBeGreaterThanOrEqual(0.95);
  });
});
