import { describe, expect, it } from "vitest";
import { anthropicRequestToOpenAI, openAIResponseToAnthropic } from "../src/anthropic.js";

function assertOnlyUserOrAssistantRoles(messages) {
  expect(Array.isArray(messages)).toBe(true);
  expect(messages.length).toBeGreaterThan(0);
  for (const msg of messages) {
    expect(["user", "assistant"]).toContain(msg.role);
  }
}

describe("Anthropic request conversion and CodeCraft role normalization", () => {
  it("1. converts a simple user message", () => {
    const result = anthropicRequestToOpenAI({
      model: "claude-opus-5.5",
      messages: [{ role: "user", content: "Hello world" }],
    }, {});

    assertOnlyUserOrAssistantRoles(result.payload.messages);
    expect(result.payload.messages).toEqual([
      { role: "user", content: "Hello world" },
    ]);
  });

  it("2. preserves multiple user/assistant turns in order", () => {
    const result = anthropicRequestToOpenAI({
      model: "claude-opus-5.5",
      messages: [
        { role: "user", content: "First question" },
        { role: "assistant", content: "First answer" },
        { role: "user", content: "Second question" },
        { role: "assistant", content: [{ type: "text", text: "Second answer" }] },
        { role: "user", content: "Third question" },
      ],
    }, {});

    assertOnlyUserOrAssistantRoles(result.payload.messages);
    expect(result.payload.messages).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Second question" },
      { role: "assistant", content: "Second answer" },
      { role: "user", content: "Third question" },
    ]);
  });

  it("3. merges top-level system prompt into the first user message without emitting a system role", () => {
    const result = anthropicRequestToOpenAI({
      model: "claude-opus-5.5",
      system: [{ type: "text", text: "Be helpful." }],
      max_tokens: 90,
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    }, {});

    expect(result.payload.model).toBe("claude-opus-5.5");
    expect(result.payload.max_tokens).toBe(90);
    assertOnlyUserOrAssistantRoles(result.payload.messages);
    expect(result.payload.messages).toEqual([
      {
        role: "user",
        content: "[System instructions]\nBe helpful.\n\n[User message]\nHello",
      },
    ]);
  });

  it("4. normalizes system and developer messages in conversation history into user messages", () => {
    const result = anthropicRequestToOpenAI({
      model: "claude-opus-5.5",
      system: "Global rule.",
      messages: [
        { role: "system", content: "System rule." },
        { role: "developer", content: [{ type: "text", text: "Developer rule." }] },
        { role: "user", content: "Initial prompt" },
        { role: "assistant", content: "Initial reply" },
        { role: "developer", content: "Mid-turn developer guidance." },
        { role: "user", content: "Follow-up prompt" },
      ],
    }, {});

    assertOnlyUserOrAssistantRoles(result.payload.messages);
    expect(result.payload.messages).toEqual([
      {
        role: "user",
        content: "[System instructions]\nGlobal rule.\n\nSystem rule.\n\nDeveloper rule.\n\n[User message]\nInitial prompt",
      },
      { role: "assistant", content: "Initial reply" },
      {
        role: "user",
        content: "[System instructions]\nMid-turn developer guidance.\n\n[User message]\nFollow-up prompt",
      },
    ]);
  });

  it("creates a safe user message when only system/developer instructions are present without user messages", () => {
    const result = anthropicRequestToOpenAI({
      model: "claude-opus-5.5",
      messages: [
        { role: "system", content: "System-only instruction" },
      ],
    }, {});

    assertOnlyUserOrAssistantRoles(result.payload.messages);
    expect(result.payload.messages).toEqual([
      { role: "user", content: "[System instructions]\nSystem-only instruction" },
    ]);
  });

  it("5. joins multiple Anthropic text blocks in a user message", () => {
    const result = anthropicRequestToOpenAI({
      model: "claude-opus-5.5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Part one." },
            { type: "text", text: "Part two." },
          ],
        },
      ],
    }, {});

    assertOnlyUserOrAssistantRoles(result.payload.messages);
    expect(result.payload.messages).toEqual([
      { role: "user", content: "Part one.\nPart two." },
    ]);
  });

  it("6 & 7. maps assistant tool_use blocks and normalizes matching tool_result blocks to user role", () => {
    const result = anthropicRequestToOpenAI({
      model: "model-x",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Reading file now." },
            { type: "tool_use", id: "call1", name: "read_file", input: { path: "a.txt" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call1", content: "file body" },
          ],
        },
      ],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          input_schema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
      tool_choice: { type: "any" },
    }, {});

    assertOnlyUserOrAssistantRoles(result.payload.messages);
    expect(result.payload.tools[0].function.name).toBe("read_file");
    expect(result.payload.tool_choice).toBe("required");
    expect(result.payload.messages[0]).toEqual({
      role: "assistant",
      content: "Reading file now.",
      tool_calls: [
        {
          id: "call1",
          type: "function",
          function: { name: "read_file", arguments: "{\"path\":\"a.txt\"}" },
        },
      ],
    });
    expect(result.payload.messages[1]).toEqual({
      role: "user",
      content: "[Tool result: read_file, call_id=call1]\nfile body",
    });
  });

  it("8. marks unmatched tool_result blocks clearly as unmatched without dropping output", () => {
    const result = anthropicRequestToOpenAI({
      model: "model-x",
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "orphan_call_99", content: "orphan tool output" },
          ],
        },
      ],
    }, {});

    assertOnlyUserOrAssistantRoles(result.payload.messages);
    expect(result.payload.messages).toHaveLength(1);
    expect(result.payload.messages[0].role).toBe("user");
    expect(result.payload.messages[0].content).toContain("unmatched");
    expect(result.payload.messages[0].content).toContain("call_id=orphan_call_99");
    expect(result.payload.messages[0].content).toContain("orphan tool output");
  });

  it("9. preserves parallel tool calls and matches all corresponding tool results in order", () => {
    const result = anthropicRequestToOpenAI({
      model: "model-x",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call_a", name: "read_file", input: { path: "a.txt" } },
            { type: "tool_use", id: "call_b", name: "list_dir", input: { path: "." } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_a", content: "contents of a" },
            { type: "tool_result", tool_use_id: "call_b", content: "a.txt\nb.txt" },
          ],
        },
      ],
    }, {});

    assertOnlyUserOrAssistantRoles(result.payload.messages);
    expect(result.payload.messages[0]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_a", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.txt\"}" } },
        { id: "call_b", type: "function", function: { name: "list_dir", arguments: "{\"path\":\".\"}" } },
      ],
    });
    expect(result.payload.messages[1]).toEqual({
      role: "user",
      content: "[Tool result: read_file, call_id=call_a]\ncontents of a\n[Tool result: list_dir, call_id=call_b]\na.txt\nb.txt",
    });
  });

  it("10. preserves an assistant message with null content and valid tool_calls", () => {
    const result = anthropicRequestToOpenAI({
      model: "model-x",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_null_1",
              type: "function",
              function: { name: "run_check", arguments: "{\"strict\":true}" },
            },
          ],
        },
        {
          role: "user",
          content: "Continue.",
        },
      ],
    }, {});

    assertOnlyUserOrAssistantRoles(result.payload.messages);
    expect(result.payload.messages[0]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_null_1",
          type: "function",
          function: { name: "run_check", arguments: "{\"strict\":true}" },
        },
      ],
    });
    expect(result.payload.messages[1]).toEqual({
      role: "user",
      content: "Continue.",
    });
  });

  it("11. normalizes historical role: 'tool' messages into labelled user messages", () => {
    const result = anthropicRequestToOpenAI({
      model: "model-x",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_hist_1",
              type: "function",
              function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_hist_1",
          content: "# Project Title",
        },
      ],
    }, {});

    assertOnlyUserOrAssistantRoles(result.payload.messages);
    expect(result.payload.messages[1]).toEqual({
      role: "user",
      content: "[Tool result: read_file, call_id=call_hist_1]\n# Project Title",
    });
  });

  it("12. normalizes historical role: 'function' messages into labelled user messages", () => {
    const result = anthropicRequestToOpenAI({
      model: "model-x",
      messages: [
        {
          role: "user",
          content: "Check status",
        },
        {
          role: "function",
          name: "get_status",
          content: "{\"healthy\":true}",
        },
      ],
    }, {});

    assertOnlyUserOrAssistantRoles(result.payload.messages);
    expect(result.payload.messages[1]).toEqual({
      role: "user",
      content: "[Tool result: get_status]\n{\"healthy\":true}",
    });
  });

  it("13. maps base64 and URL image blocks alongside text and system instructions without data loss", () => {
    const result = anthropicRequestToOpenAI({
      model: "model-x",
      system: "Inspect images carefully.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look at these" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
            { type: "image", source: { type: "url", url: "https://example.com/diagram.png" } },
          ],
        },
      ],
    }, {});

    assertOnlyUserOrAssistantRoles(result.payload.messages);
    expect(result.payload.messages[0].role).toBe("user");
    expect(result.payload.messages[0].content).toEqual([
      {
        type: "text",
        text: "[System instructions]\nInspect images carefully.\n\n[User message]\nLook at these",
      },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
      { type: "image_url", image_url: { url: "https://example.com/diagram.png" } },
    ]);
  });

  it("14. rejects malformed messages and malformed content blocks safely", () => {
    expect(() => anthropicRequestToOpenAI(null, {})).toThrow(/JSON object/);
    expect(() => anthropicRequestToOpenAI({ model: "x", messages: [] }, {})).toThrow(/non-empty array/);
    expect(() => anthropicRequestToOpenAI({ model: "x", messages: [null] }, {})).toThrow(/JSON object/);
    expect(() => anthropicRequestToOpenAI({
      model: "x",
      messages: [{ role: "user", content: 12345 }],
    }, {})).toThrow(/string or content-block array/);
    expect(() => anthropicRequestToOpenAI({
      model: "x",
      messages: [{ role: "assistant", content: null }],
    }, {})).toThrow(/at least one valid tool call/);
    expect(() => anthropicRequestToOpenAI({
      model: "x",
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", data: "" } }] }],
    }, {})).toThrow(/image content block/);
    expect(() => anthropicRequestToOpenAI({
      model: "x",
      messages: [{ role: "user", content: [{ type: "unsupported_widget", foo: "bar" }] }],
    }, {})).toThrow(/Unsupported content block type "unsupported_widget"/);
  });

  it("15. rejects unsupported roles by naming the role without exposing private content", () => {
    const secretPrompt = "TOP_SECRET_PRIVATE_MESSAGE_CONTENT_DO_NOT_LEAK";
    let caughtError = null;
    try {
      anthropicRequestToOpenAI({
        model: "x",
        messages: [{ role: "moderator", content: secretPrompt }],
      }, {});
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(TypeError);
    expect(caughtError.message).toContain("moderator");
    expect(caughtError.message).not.toContain(secretPrompt);
  });

  it("applies an explicit model map without forcing all requests to one model", () => {
    const result = anthropicRequestToOpenAI({
      model: "claude-haiku-alias",
      messages: [{ role: "user", content: "hello" }],
    }, { MODEL_MAP_JSON: '{"claude-haiku-alias":"claude-fable-5.1"}' });

    expect(result.payload.model).toBe("claude-fable-5.1");
  });

  it("supports explicit text fallback for historical assistant tool_calls when NORMALIZE_ASSISTANT_TOOL_CALLS=1", () => {
    const result = anthropicRequestToOpenAI({
      model: "model-x",
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_fb_1", name: "read_file", input: { path: "notes.txt" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_fb_1", content: "note contents" }],
        },
      ],
    }, { NORMALIZE_ASSISTANT_TOOL_CALLS: "1" });

    assertOnlyUserOrAssistantRoles(result.payload.messages);
    expect(result.payload.messages[0]).toEqual({
      role: "assistant",
      content: "[Assistant tool call: read_file, call_id=call_fb_1]\nArguments: {\"path\":\"notes.txt\"}",
    });
    expect(result.payload.messages[0].tool_calls).toBeUndefined();
    expect(result.payload.messages[1]).toEqual({
      role: "user",
      content: "[Tool result: read_file, call_id=call_fb_1]\nnote contents",
    });
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
