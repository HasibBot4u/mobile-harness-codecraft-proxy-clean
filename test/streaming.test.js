import { describe, expect, it } from "vitest";
import { openAIStreamToAnthropic } from "../src/streaming.js";
import { openAIData, parseSSE, readAll, streamFromChunks } from "./helpers.js";

function chunk(choices, usage) {
  const data = { choices };
  if (usage) data.usage = usage;
  return openAIData(data);
}

describe("OpenAI SSE to Anthropic SSE", () => {
  it("streams text and terminates with the Anthropic event sequence", async () => {
    const upstream = streamFromChunks([
      chunk([{ delta: { role: "assistant", content: "Hel" }, finish_reason: null }]),
      chunk([{ delta: { content: "lo" }, finish_reason: null }]),
      chunk([{ delta: {}, finish_reason: "stop" }], { prompt_tokens: 5, completion_tokens: 1 }),
      "data: [DONE]\n\n",
    ]);
    const events = parseSSE(await readAll(openAIStreamToAnthropic(upstream, { model: "model-x", inputTokens: 5 })));
    const names = events.map((event) => event.event);

    expect(names[0]).toBe("message_start");
    expect(names).toContain("content_block_start");
    expect(names).toContain("content_block_delta");
    expect(names).toContain("content_block_stop");
    expect(names[names.length - 2]).toBe("message_delta");
    expect(names[names.length - 1]).toBe("message_stop");

    const text = events.filter((event) => event.event === "content_block_delta" && event.data.delta.type === "text_delta").map((event) => event.data.delta.text).join("");
    expect(text).toBe("Hello");

    const delta = events.find((event) => event.event === "message_delta");
    expect(delta.data.delta.stop_reason).toBe("end_turn");
    expect(delta.data.usage).toEqual({ input_tokens: 5, output_tokens: 1 });
  });

  it("preserves parallel tool calls without reusing stopped block indices", async () => {
    const upstream = streamFromChunks([
      chunk([{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "alpha", arguments: "{\"a\":" } }] }, finish_reason: null }]),
      chunk([{ delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "beta", arguments: "{\"b\":" } }] }, finish_reason: null }]),
      chunk([{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: null }]),
      chunk([{ delta: { tool_calls: [{ index: 1, function: { arguments: "2}" } }] }, finish_reason: null }]),
      chunk([{ delta: {}, finish_reason: "tool_calls" }], { prompt_tokens: 4, completion_tokens: 5 }),
      "data: [DONE]\n\n",
    ]);
    const events = parseSSE(await readAll(openAIStreamToAnthropic(upstream, { model: "model-x" })));
    const starts = events.filter((event) => event.event === "content_block_start" && event.data.content_block.type === "tool_use");

    expect(starts.map((event) => event.data.content_block.id)).toEqual(["call_a", "call_b"]);
    for (const start of starts) {
      const index = start.data.index;
      const partial = events.filter((event) => event.event === "content_block_delta" && event.data.index === index && event.data.delta.type === "input_json_delta").map((event) => event.data.delta.partial_json).join("");
      expect(() => JSON.parse(partial)).not.toThrow();
    }

    expect(events.find((event) => event.event === "message_delta").data.delta.stop_reason).toBe("tool_use");
    expect(events.at(-1).event).toBe("message_stop");
  });

  it("handles CRLF event boundaries and a final buffer without a trailing blank line", async () => {
    const upstream = streamFromChunks([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\r\n\r\n',
    ]);
    const events = parseSSE(await readAll(openAIStreamToAnthropic(upstream, { model: "model-x" })));
    const deltas = events.filter((event) => event.event === "content_block_delta");
    expect(deltas[0].data.delta.text).toBe("OK");
  });
});
