import { describe, it, expect, vi } from "vitest";
import { AiChatResponse } from "@workspace/api-zod";
import { isAiEvent, parseFrame, pollForAnswer, readEvents, streamAnswer, type AiEvent } from "./aiStream";

/**
 * (F8) Ported from h2's `data/aiStream.test.ts`, plus the Stop cases.
 * ⭐ THE STREAM PARSER. Frames in, text out; a frame that fails validation is
 * ignored, never thrown; a dropped stream is a result the caller polls for.
 * `isAiEvent` is held to the generated zod schema so the two cannot drift.
 */
const enc = new TextEncoder();
const frame = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const streamOf = (chunks: string[], fail = false) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      if (fail) c.error(new Error("network"));
      else c.close();
    },
  });
const respond = (chunks: string[], init: ResponseInit = { status: 200 }, fail = false) =>
  vi.fn(async () => new Response(streamOf(chunks, fail), init)) as unknown as typeof fetch;
async function all(body: ReadableStream<Uint8Array>): Promise<AiEvent[]> {
  const out: AiEvent[] = [];
  for await (const e of readEvents(body)) out.push(e);
  return out;
}

describe("frames", () => {
  it("parses a token frame and ignores comments (pings)", () => {
    expect(parseFrame(": ping\n\nevent: token\ndata: {\"type\":\"token\",\"text\":\"Hi\"}")).toEqual({ type: "token", text: "Hi" });
    expect(parseFrame(": ping")).toBeNull();
  });
  it("an invalid frame is ignored: bad JSON, unknown type, wrong field type", () => {
    expect(parseFrame("data: {nope")).toBeNull();
    expect(parseFrame('data: {"type":"banana"}')).toBeNull();
    expect(parseFrame('data: {"type":"token","text":5}')).toBeNull();
    expect(parseFrame('data: {"type":"tool","status":"later"}')).toBeNull();
    expect(parseFrame("data: [1]")).toBeNull();
  });
  it("agrees with the generated zod schema on a spread of events", () => {
    const cases: unknown[] = [
      { type: "token", text: "a" },
      { type: "tool", name: "get_position", status: "running" },
      { type: "done", runId: "r", messageId: "m", text: "t", grounded: true, demo: false },
      { type: "error", code: "x", message: "m", retryable: true },
      { type: "nope" },
      { type: "token", text: 1 },
      { type: "tool", status: "paused" },
      { type: "done", grounded: "yes" },
      {},
      null,
    ];
    for (const c of cases) expect(isAiEvent(c), JSON.stringify(c)).toBe(AiChatResponse.safeParse(c).success);
  });
});

describe("readEvents", () => {
  it("yields events in order and holds a frame split across chunks", async () => {
    const whole = frame("token", { type: "token", text: "Hel" }) + frame("token", { type: "token", text: "lo" });
    const cut = 20;
    const events = await all(streamOf([whole.slice(0, cut), whole.slice(cut)]));
    expect(events.map((e) => e.text)).toEqual(["Hel", "lo"]);
  });
  it("skips an invalid frame in the middle and keeps going", async () => {
    const events = await all(streamOf([frame("token", { type: "token", text: "a" }), "data: {bad\n\n", frame("token", { type: "token", text: "b" })]));
    expect(events.map((e) => e.text)).toEqual(["a", "b"]);
  });
  it("reads CRLF frames", async () => {
    const events = await all(streamOf(['data: {"type":"token","text":"x"}\r\n\r\n']));
    expect(events).toEqual([{ type: "token", text: "x" }]);
  });
});

describe("streamAnswer", () => {
  it("appends tokens, reports tools, and finishes on done (whose text replaces the tokens)", async () => {
    const tokens: string[] = [];
    const tools: string[] = [];
    const f = respond([
      frame("tool", { type: "tool", name: "get_spending_summary", status: "running" }),
      frame("token", { type: "token", text: "You spent " }),
      frame("token", { type: "token", text: "$12" }),
      frame("done", { type: "done", runId: "r1", messageId: "m1", text: "You spent $12.", grounded: true, demo: false }),
    ]);
    const r = await streamAnswer({ conversationId: "c1", text: "q", userAskedToChange: false, fetchImpl: f, onToken: (t) => tokens.push(t), onTool: (n, s) => tools.push(`${n}:${s}`) });
    expect(tokens.join("")).toBe("You spent $12");
    expect(tools).toEqual(["get_spending_summary:running"]);
    expect(r).toEqual({ kind: "done", done: { text: "You spent $12.", runId: "r1", messageId: "m1", grounded: true, demo: false } });
  });
  it("posts the question with credentials and the user-asked flag", async () => {
    const f = respond([frame("done", { type: "done", text: "ok" })]);
    await streamAnswer({ conversationId: "c9", text: "File the Sample Diner charge", userAskedToChange: true, fetchImpl: f });
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/ai/chat");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(init.body as string)).toEqual({ conversationId: "c9", text: "File the Sample Diner charge", userAskedToChange: true });
  });
  it("an error frame is the server's own words", async () => {
    const f = respond([frame("error", { type: "error", code: "budget_exceeded", message: "Ask has reached its limit for now.", retryable: false })]);
    const r = await streamAnswer({ conversationId: "c", text: "q", userAskedToChange: false, fetchImpl: f });
    expect(r).toEqual({ kind: "error", code: "budget_exceeded", message: "Ask has reached its limit for now.", retryable: false });
  });
  it("a stream that ends without done or error is dropped", async () => {
    const f = respond([frame("token", { type: "token", text: "half" })]);
    expect((await streamAnswer({ conversationId: "c", text: "q", userAskedToChange: false, fetchImpl: f })).kind).toBe("dropped");
  });
  it("a reader that throws mid-stream is dropped, not thrown", async () => {
    const f = respond([frame("token", { type: "token", text: "half" })], { status: 200 }, true);
    expect((await streamAnswer({ conversationId: "c", text: "q", userAskedToChange: false, fetchImpl: f })).kind).toBe("dropped");
  });
  it("a failed request is dropped; a refusal says why", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    expect((await streamAnswer({ conversationId: "c", text: "q", userAskedToChange: false, fetchImpl: down })).kind).toBe("dropped");
    const busy = await streamAnswer({ conversationId: "c", text: "q", userAskedToChange: false, fetchImpl: respond([], { status: 409 }) });
    expect(busy).toMatchObject({ kind: "error", code: "http_409", message: "H2 is still answering the last question." });
    const limited = await streamAnswer({ conversationId: "c", text: "q", userAskedToChange: false, fetchImpl: respond([], { status: 429 }) });
    expect(limited).toMatchObject({ kind: "error", retryable: true });
  });
});

describe("pollForAnswer", () => {
  const msgs = (...roles: string[]) => ({ messages: roles.map((role) => ({ role })) });
  it("polls until the assistant's answer is stored", async () => {
    const getDetail = vi
      .fn()
      .mockResolvedValueOnce(msgs("user"))
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValueOnce(msgs("user", "assistant"));
    const sleep = vi.fn(async () => {});
    expect(await pollForAnswer({ assistantBefore: 0, getDetail, sleep })).toBe(true);
    expect(getDetail).toHaveBeenCalledTimes(3);
  });
  it("an older answer does not count", async () => {
    const getDetail = vi.fn().mockResolvedValue(msgs("user", "assistant", "user"));
    expect(await pollForAnswer({ assistantBefore: 1, getDetail, sleep: async () => {}, tries: 3 })).toBe(false);
    expect(getDetail).toHaveBeenCalledTimes(3);
  });
});

describe("Stop (classic)", () => {
  it("an aborted request is 'aborted', not a drop to poll for", async () => {
    const ctrl = new AbortController();
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      ctrl.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError", signal: init?.signal });
    }) as unknown as typeof fetch;
    expect(await streamAnswer({ conversationId: "c", text: "q", userAskedToChange: false, fetchImpl: f, signal: ctrl.signal })).toEqual({ kind: "aborted" });
  });
  it("a stream stopped mid-answer is 'aborted'", async () => {
    const ctrl = new AbortController();
    const f = vi.fn(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode(frame("token", { type: "token", text: "half" })));
            ctrl.abort();
            c.error(new Error("aborted"));
          },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    expect((await streamAnswer({ conversationId: "c", text: "q", userAskedToChange: false, fetchImpl: f, signal: ctrl.signal })).kind).toBe("aborted");
  });
  it("an already-stopped signal sends nothing", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const f = vi.fn() as unknown as typeof fetch;
    expect((await streamAnswer({ conversationId: "c", text: "q", userAskedToChange: false, fetchImpl: f, signal: ctrl.signal })).kind).toBe("aborted");
    expect(f).not.toHaveBeenCalled();
  });
});
