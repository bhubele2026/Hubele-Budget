import { describe, it, expect } from "vitest";
// The SDK helpers are typed against `zod/v4`. The workspace pins zod ^3.25.76
// (catalog + override), which ships the v4 API at the `zod/v4` subpath. Every
// schema handed to a model therefore comes from `zod/v4`, never bare `zod`.
import * as z from "zod/v4";
import { z as zClassic } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";

const Pick = z.object({
  categoryId: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  rationale: z.string().max(140),
});

describe("SDK zod helpers accept a schema built with the workspace zod", () => {
  it("zodOutputFormat produces a json_schema format that parses and validates", () => {
    const fmt = zodOutputFormat(Pick);
    expect(fmt.type).toBe("json_schema");
    const schema = fmt.schema as { type?: string; properties?: Record<string, unknown> };
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties ?? {})).toEqual(["categoryId", "confidence", "rationale"]);
    const parsed = fmt.parse(
      JSON.stringify({ categoryId: "c1", confidence: "high", rationale: "matches a prior" }),
    );
    expect(parsed).toEqual({ categoryId: "c1", confidence: "high", rationale: "matches a prior" });
    // Content that breaks the schema is refused by the helper itself.
    expect(() => fmt.parse(JSON.stringify({ categoryId: "c1", confidence: "certain" }))).toThrow();
    expect(() => fmt.parse("not json")).toThrow();
  });

  it("betaZodTool builds a runnable tool from the same zod", async () => {
    const tool = betaZodTool({
      name: "ping",
      description: "Echo a word back.",
      inputSchema: z.object({ word: z.string() }),
      run: (args) => `pong:${args.word}`,
    });
    expect(tool.name).toBe("ping");
    // BetaRunnableTool is a union over tool kinds; a zod tool is the `custom` arm.
    const def = tool as unknown as {
      type: string;
      input_schema: { type?: string; properties?: Record<string, unknown> };
    };
    expect(def.type).toBe("custom");
    expect(def.input_schema.type).toBe("object");
    expect(Object.keys(def.input_schema.properties ?? {})).toEqual(["word"]);
    expect(tool.parse({ word: "hi" })).toEqual({ word: "hi" });
    expect(() => tool.parse({ word: 7 })).toThrow();
    expect(await tool.run({ word: "hi" })).toBe("pong:hi");
  });

  it("a classic (bare `zod`) schema is NOT accepted — model schemas must come from zod/v4", () => {
    const classic = zClassic.object({ a: zClassic.string() });
    expect(() => zodOutputFormat(classic as unknown as z.ZodType)).toThrow();
  });
});
