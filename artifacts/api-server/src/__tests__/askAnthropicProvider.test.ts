// (AI-2) The live provider's tool loop, against a stub client (no network):
// what it asks the SDK for, and what it reads back from each reply.

import { describe, it, expect } from "vitest";
import * as z from "zod/v4";
import type Anthropic from "@anthropic-ai/sdk";
import { createAnthropicProvider } from "../ai/anthropicProvider";
import type { AgentTool, ToolLoopCall } from "../ai/provider";

function stubClient(replies: Array<Record<string, unknown> | Error>, seen: { params?: any; options?: any }) {
  return {
    beta: {
      messages: {
        toolRunner(params: any, options: any) {
          seen.params = params;
          seen.options = options;
          return {
            async *[Symbol.asyncIterator]() {
              for (const r of replies) {
                if (r instanceof Error) throw r;
                const texts: Array<(d: string) => void> = [];
                yield {
                  on: (ev: string, cb: (d: string) => void) => ev === "text" && texts.push(cb),
                  finalMessage: async () => {
                    for (const t of texts) t("streamed ");
                    return r;
                  },
                };
              }
            },
          };
        },
      },
    },
  } as unknown as Anthropic;
}
const msg = (stop: string, text: string, usage: Record<string, number>) => ({
  id: `msg_${stop}`,
  model: "claude-opus-5-5",
  stop_reason: stop,
  content: [{ type: "text", text }],
  usage,
});

const tool: AgentTool = {
  name: "echo",
  description: "echo",
  inputSchema: z.object({ n: z.number().min(0).max(5), s: z.string().max(10) }).strict(),
  run: async (i) => JSON.stringify(i),
};
const call = (over: Partial<ToolLoopCall> = {}): ToolLoopCall => ({
  task: "chat",
  model: "claude-opus-5-5",
  effort: "low",
  maxTokens: 4096,
  maxIterations: 8,
  system: "SYSTEM",
  messages: [{ role: "user", content: "hi" }],
  tools: [tool],
  ...over,
});

describe("anthropic runTools", () => {
  it("sends strict tools, a cached system block, effort, the fallback beta; reads usage per reply", async () => {
    const seen: { params?: any; options?: any } = {};
    const streamed: string[] = [];
    const p = createAnthropicProvider(() =>
      stubClient(
        [
          msg("tool_use", "", { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 5, cache_read_input_tokens: 0 }),
          msg("end_turn", "Done.", { input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 5 }),
        ],
        seen,
      ),
    );
    const ac = new AbortController();
    const res = await p.runTools(call({ onText: (d) => streamed.push(d), signal: ac.signal }));
    expect(res).toMatchObject({ text: "Done.", stopReason: "end_turn", demo: false });
    expect(res.turns).toHaveLength(2);
    expect(res.turns[0]).toMatchObject({ requestId: "msg_tool_use", usage: { inputTokens: 10, outputTokens: 2, cacheWriteTokens: 5, cacheReadTokens: 0 } });
    expect(res.turns[1]!.usage).toEqual({ inputTokens: 20, outputTokens: 4, cacheWriteTokens: 0, cacheReadTokens: 5 });
    expect(streamed).toEqual(["streamed ", "streamed "]);

    const { params, options } = seen;
    expect(params).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 4096,
      max_iterations: 8,
      stream: true,
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01"],
      output_config: { effort: "low" },
      system: [{ type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } }],
    });
    expect(params.tool_choice).toBeUndefined(); // auto
    expect(options.signal).toBe(ac.signal);
    const t = params.tools[0];
    expect(t).toMatchObject({ name: "echo", strict: true });
    expect(t.input_schema.additionalProperties).toBe(false);
    expect(typeof t.run).toBe("function");
    expect(JSON.parse(await t.run({ n: 1, s: "x" }))).toEqual({ n: 1, s: "x" });
    expect(() => t.parse({ n: 1, s: "x", household: "h" })).toThrow(); // the SDK validates with the strict schema
  });

  it("returns tool_use as the stop reason when the iteration cap cut the loop", async () => {
    const p = createAnthropicProvider(() => stubClient([msg("tool_use", "", { input_tokens: 1, output_tokens: 1 })], {}));
    expect((await p.runTools(call())).stopReason).toBe("tool_use");
  });

  it("hands the replies that finished to the caller when a later one fails", async () => {
    const p = createAnthropicProvider(() => stubClient([msg("tool_use", "", { input_tokens: 7, output_tokens: 1 }), new Error("503")], {}));
    const err = await p.runTools(call()).catch((e) => e);
    expect(err.message).toBe("503");
    expect(err.turns).toHaveLength(1);
    expect(err.turns[0].usage.inputTokens).toBe(7);
  });
});
