import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { AiProvider, StructuredCall, StructuredResponse } from "./provider";

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
  };
}
