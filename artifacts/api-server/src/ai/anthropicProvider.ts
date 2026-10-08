import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { transformJSONSchema } from "@anthropic-ai/sdk/lib/transform-json-schema";
import type { AiProvider, StructuredCall, StructuredResponse, ToolLoopCall, ToolLoopResponse, ToolLoopTurn } from "./provider";

// (AI-0) The live provider: one structured-output call through
// client.messages.parse + zodOutputFormat.
//
// The helper's own parse step THROWS on output that does not decode, which
// would lose the response — and with it the usage we must ledger. So the
// format keeps the helper's JSON schema but swaps in a parse that only
// decodes JSON and returns null on failure: `parsed_output` is then null
// exactly when the output is unusable, and runStructured does the zod check
// itself (code validates every output).
//
// requestId: the SDK drops the `request-id` header from a parse() result, so
// a success records the message id (msg_…); an API error records the error's
// request id (req_…).

export function createAnthropicProvider(getClient: () => Anthropic): AiProvider {
  return {
    name: "anthropic",
    async callStructured(call: StructuredCall): Promise<StructuredResponse> {
      const helper = zodOutputFormat(call.schema);
      let parseError: string | null = null;
      const format = {
        ...helper,
        parse: (content: string): unknown => {
          try {
            return JSON.parse(content);
          } catch (err) {
            parseError = err instanceof Error ? err.message : String(err);
            return null;
          }
        },
      } as typeof helper;

      const res = await getClient().messages.parse(
        {
          model: call.model,
          max_tokens: call.maxTokens,
          system: [
            { type: "text", text: call.system, cache_control: { type: "ephemeral" } },
          ],
          messages: call.messages,
          output_config: { effort: call.effort, format },
        },
        { timeout: call.timeoutMs, maxRetries: call.maxRetries },
      );

      return {
        parsed: res.parsed_output ?? null,
        parseError: res.parsed_output == null ? (parseError ?? "no text block in the response") : null,
        stopReason: res.stop_reason ?? null,
        model: res.model,
        usage: {
          inputTokens: res.usage.input_tokens ?? 0,
          outputTokens: res.usage.output_tokens ?? 0,
          cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
          cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
        },
        requestId: res.id ?? null,
        demo: false,
      };
    },
    // (AI-2) The tool loop: client.beta.messages.toolRunner does the
    // model <-> tool round trips (and resumes a paused turn itself); this only
    // reads each reply's usage and stop reason. Tools are strict, tool_choice
    // stays auto, thinking is on by default on claude-opus-5-5 and
    // `output_config.effort` is the spend dial. The runner stops at
    // `max_iterations`; a last reply that still asks for a tool comes back
    // with stopReason "tool_use" and the caller treats it as a failure.
    async runTools(call: ToolLoopCall): Promise<ToolLoopResponse> {
      const tools = call.tools.map((t) => {
        const base = betaZodTool({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          run: (args) => t.run(args),
        });
        const schema = (base as unknown as { input_schema: Record<string, any> }).input_schema;
        return { ...base, input_schema: transformJSONSchema(schema), strict: true } as typeof base;
      });
      const runner = getClient().beta.messages.toolRunner(
        {
          model: call.model,
          max_tokens: call.maxTokens,
          system: [{ type: "text", text: call.system, cache_control: { type: "ephemeral" } }],
          tools,
          messages: call.messages as never,
          max_iterations: call.maxIterations,
          output_config: { effort: call.effort },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          stream: true,
        },
        { ...(call.signal ? { signal: call.signal } : {}) },
      );
      const turns: ToolLoopTurn[] = [];
      type Last = { stop_reason: string | null; content: Array<{ type: string; text?: string }> };
      let last = null as Last | null;
      try {
      for await (const stream of runner) {
        if (call.onText) stream.on("text", (delta: string) => call.onText!(delta));
        const message = await stream.finalMessage();
        turns.push({
          model: message.model,
          usage: {
            inputTokens: message.usage.input_tokens ?? 0,
            outputTokens: message.usage.output_tokens ?? 0,
            cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
            cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
          },
          requestId: message.id ?? null,
          stopReason: message.stop_reason ?? null,
        });
        last = message as never;
      }
      } catch (err) {
        // The replies that did finish were billed: hand them to the caller's ledger.
        if (err && typeof err === "object") (err as { turns?: ToolLoopTurn[] }).turns = turns;
        throw err;
      }
      const text = (last?.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      return { text, stopReason: last?.stop_reason ?? null, turns, demo: false };
    },
  };
}
