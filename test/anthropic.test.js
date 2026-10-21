import { describe, expect, it } from "vitest";
import { anthropicRequestToOpenAI, openAIResponseToAnthropic } from "../src/anthropic.js";

describe("Anthropic request conversion", () => {
  it("maps system text, model, max_tokens and normal text messages", () => {
    const result = anthropicRequestToOpenAI({
      model: "claude-opus-5.5",
      system: [{ type: "text", text: "Be helpful." }],
      max_tokens: 90,
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    }, {});

    expect(result.payload.model).toBe("claude-opus-5.5");
    expect(result.payload.max_tokens).toBe(90);
    expect(result.payload.messages).toEqual([
      { role: "system", content: "Be helpful." },
      { role: "user", content: "Hello" },
    ]);
  });

  it("maps base64 image blocks to OpenAI image_url parts", () => {
    const result = anthropicRequestToOpenAI({
      model: "model-x",
      messages: [{ role: "user", content: [
        { type: "text", text: "Look" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
      ] }],
    }, {});

    expect(result.payload.messages[0].content[0]).toEqual({ type: "text", text: "Look" });
    expect(result.payload.messages[0].content[1].image_url.url).toBe("data:image/png;base64,QUJD");
  });

  it("maps tools, required tool choice and assistant tool-use history", () => {
    const result = anthropicRequestToOpenAI({
      model: "model-x",
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call1", name: "read_file", input: { path: "a.txt" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call1", content: "file body" }] },
      ],
      tools: [{ name: "read_file", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
      tool_choice: { type: "any" },
    }, {});

    expect(result.payload.tools[0].function.name).toBe("read_file");
    expect(result.payload.tool_choice).toBe("required");
    expect(result.payload.messages[0].tool_calls[0].id).toBe("call1");
    expect(result.payload.messages[1]).toEqual({ role: "tool", tool_call_id: "call1", content: "file body" });
  });

  it("applies an explicit model map without forcing all requests to one model", () => {
    const result = anthropicRequestToOpenAI({
      model: "claude-haiku-alias",
      messages: [{ role: "user", content: "hello" }],
    }, { MODEL_MAP_JSON: '{"claude-haiku-alias":"claude-fable-5.1"}' });

    expect(result.payload.model).toBe("claude-fable-5.1");
  });

  it("rejects malformed Messages API request structure", () => {
    expect(() => anthropicRequestToOpenAI({ model: "x", messages: [] }, {})).toThrow(/non-empty array/);
  });
});

describe("OpenAI response conversion", () => {
  it("maps text, usage and finish reason", () => {
    const result = openAIResponseToAnthropic({
      id: "chatcmpl-1",
      model: "claude-opus-5.5",
      choices: [{ message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    }, "claude-opus-5.5", 5);

    expect(result.type).toBe("message");
    expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(result.stop_reason).toBe("end_turn");
    expect(result.usage).toEqual({ input_tokens: 7, output_tokens: 3 });
  });

  it("maps tool_calls to tool_use and length to max_tokens", () => {
    const result = openAIResponseToAnthropic({
      choices: [{
        message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "ls", arguments: "{\"path\":\".\"}" } }] },
        finish_reason: "tool_calls",
      }],
    }, "model-x");

    expect(result.stop_reason).toBe("tool_use");
    expect(result.content[0]).toMatchObject({ type: "tool_use", id: "c1", name: "ls", input: { path: "." } });

    const truncated = openAIResponseToAnthropic({
      choices: [{ message: { role: "assistant", content: "partial" }, finish_reason: "length" }],
    }, "model-x");
    expect(truncated.stop_reason).toBe("max_tokens");
  });
});
