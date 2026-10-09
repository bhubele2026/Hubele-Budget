import { describe, it, expect } from "vitest";
import { cn } from "./utils";

// tailwind-merge pattern-matches; an unknown `text-<step>` falls into the
// COLOUR group and two "colours" collide. Every @theme type step must be listed.
describe("cn knows the design tokens", () => {
  it("keeps a type step beside a text colour (kpi and hero included)", () => {
    for (const step of ["hero", "kpi", "display", "title", "body", "label", "micro"]) {
      expect(cn(`text-${step}`, "text-brand-navy").split(" ")).toEqual([`text-${step}`, "text-brand-navy"]);
    }
  });
  it("treats the milled shadows as shadows", () => {
    expect(cn("shadow-milled", "shadow-milled-lift")).toBe("shadow-milled-lift");
  });
});
