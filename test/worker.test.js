import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker.js";

afterEach(() => vi.unstubAllGlobals());

const token = "test-proxy-token";
const upstreamKey = "cc_test_upstream_key";
const env = {
  REQUIRE_PROXY_TOKEN: "1",
  PROXY_TOKEN: token,
  UPSTREAM_BASE_URL: "https://codecraftapi.com/v1",
  UPSTREAM_API_KEY: upstreamKey,
  DEFAULT_MODEL: "claude-opus-5.5",
  MODEL_MAP_JSON: "{}",
  ESTIMATE_TOKENS_PER_CHAR: "0.25",
  MAX_REQUEST_BYTES: "20000000",
};

function makeRequest(path, { method = "GET", apiKey, body, headers = {} } = {}) {
  const finalHeaders = new Headers(headers);
  if (apiKey) finalHeaders.set("x-api-key", apiKey);
  if (body !== undefined) finalHeaders.set("content-type", "application/json");
  return new Request(`https://worker.test${path}`, {
    method,
    headers: finalHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const validBody = {
  model: "claude-opus-5.5",
  max_tokens: 64,
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};

describe("Worker routes and security", () => {
  it("reports configured health without revealing secret values", async () => {
    const response = await worker.fetch(makeRequest("/health"), env);
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(JSON.stringify(data)).not.toContain(upstreamKey);
    expect(JSON.stringify(data)).not.toContain(token);
  });

  it("rejects an invalid key before attempting upstream fetch", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    const response = await worker.fetch(makeRequest("/v1/messages", { method: "POST", apiKey: "wrong", body: validBody }), env);
    expect(response.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("protects count_tokens", async () => {
    const response = await worker.fetch(makeRequest("/v1/messages/count_tokens", {
      method: "POST", apiKey: "wrong", body: { messages: [{ role: "user", content: "hi" }] },
    }), env);
    expect(response.status).toBe(401);
  });

  it("sends the server-side API key to the fixed upstream, not the proxy token", async () => {
    const mockFetch = vi.fn(async (url, init) => {
      expect(String(url)).toBe("https://codecraftapi.com/v1/chat/completions");
      expect(init.headers.authorization).toBe(`Bearer ${upstreamKey}`);
      expect(init.headers.authorization).not.toBe(`Bearer ${token}`);
      return Response.json({
        id: "chatcmpl-test",
        model: "claude-opus-5.5",
        choices: [{ message: { role: "assistant", content: "PROXY_OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 2 },
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const response = await worker.fetch(makeRequest("/v1/messages", { method: "POST", apiKey: token, body: validBody }), env);
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.type).toBe("message");
    expect(data.content[0].text).toBe("PROXY_OK");
  });

  it("returns Anthropic SSE when the upstream streams", async () => {
    const upstreamBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "STREAM_OK" }, finish_reason: null }] })}\n\n`,
        ));
        controller.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
        ));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(upstreamBody, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    })));

    const response = await worker.fetch(makeRequest("/v1/messages", {
      method: "POST",
      apiKey: token,
      body: { ...validBody, stream: true },
    }), env);
    const raw = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(raw).toContain("event: message_start");
    expect(raw).toContain("STREAM_OK");
    expect(raw).toContain("event: message_stop");
  });

  it("rejects JSON from upstream when streaming was requested", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [] })));
    const response = await worker.fetch(makeRequest("/v1/messages", {
      method: "POST",
      apiKey: token,
      body: { ...validBody, stream: true },
    }), env);
    expect(response.status).toBe(502);
    expect((await response.json()).error.message).toMatch(/text\/event-stream/);
  });

  it("ignores client-supplied upstream URL headers", async () => {
    const mockFetch = vi.fn(async (url) => {
      expect(String(url)).toBe("https://codecraftapi.com/v1/chat/completions");
      return Response.json({
        id: "chatcmpl-test",
        model: "claude-opus-5.5",
        choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const response = await worker.fetch(makeRequest("/v1/messages", {
      method: "POST",
      apiKey: token,
      headers: { "x-base-url": "https://attacker.invalid/v1" },
      body: validBody,
    }), env);
    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown routes", async () => {
    const response = await worker.fetch(makeRequest("/does-not-exist"), env);
    expect(response.status).toBe(404);
  });

  it("16. guarantees the exact serialized upstream request contains only user and assistant roles while preserving system instructions, tool results, and order", async () => {
    let capturedUrl = null;
    let capturedHeaders = null;
    let capturedBody = null;

    const mockFetch = vi.fn(async (url, init) => {
      capturedUrl = String(url);
      capturedHeaders = init.headers;
      capturedBody = JSON.parse(init.body);
      return Response.json({
        id: "chatcmpl-role-check",
        model: "claude-opus-5.5",
        choices: [{ message: { role: "assistant", content: "All normalized." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 42, completion_tokens: 4 },
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const complexRequest = {
      model: "claude-opus-5.5",
      max_tokens: 256,
      system: "Top-level system instruction.",
      messages: [
        { role: "system", content: "History system instruction." },
        { role: "developer", content: "Developer policy instruction." },
        { role: "user", content: [{ type: "text", text: "Inspect the repo." }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checking files." },
            { type: "tool_use", id: "call_101", name: "read_file", input: { path: "package.json" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_101", content: "{\"name\":\"demo\"}" },
          ],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_102", type: "function", function: { name: "run_linter", arguments: "{}" } },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_102",
          content: "0 errors",
        },
        {
          role: "function",
          name: "legacy_check",
          content: "ok",
        },
        {
          role: "user",
          content: "Summarize findings.",
        },
      ],
    };

    const response = await worker.fetch(makeRequest("/v1/messages", {
      method: "POST",
      apiKey: token,
      body: complexRequest,
    }), env);

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(capturedUrl).toBe("https://codecraftapi.com/v1/chat/completions");
    expect(capturedHeaders.authorization).toBe(`Bearer ${upstreamKey}`);
    expect(capturedBody.model).toBe("claude-opus-5.5");

    expect(Array.isArray(capturedBody.messages)).toBe(true);
    expect(capturedBody.messages.length).toBe(7);
    for (const msg of capturedBody.messages) {
      expect(["user", "assistant"]).toContain(msg.role);
    }

    const combinedContent = capturedBody.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(combinedContent).toContain("Top-level system instruction.");
    expect(combinedContent).toContain("History system instruction.");
    expect(combinedContent).toContain("Developer policy instruction.");
    expect(combinedContent).toContain("read_file");
    expect(combinedContent).toContain("call_101");
    expect(combinedContent).toContain("{\"name\":\"demo\"}");
    expect(combinedContent).toContain("run_linter");
    expect(combinedContent).toContain("call_102");
    expect(combinedContent).toContain("0 errors");
    expect(combinedContent).toContain("legacy_check");
    expect(combinedContent).toContain("Summarize findings.");

    expect(capturedBody.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "user",
      "user",
    ]);
  });

  it("17. returns a safe 400 error on unsupported roles without leaking credentials or private message content", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const sensitiveContent = "PRIVATE_USER_SECRET_PROMPT_987654321";
    const response = await worker.fetch(makeRequest("/v1/messages", {
      method: "POST",
      apiKey: token,
      body: {
        model: "claude-opus-5.5",
        max_tokens: 64,
        messages: [
          { role: "moderator", content: sensitiveContent },
        ],
      },
    }), env);

    const data = await response.json();
    const rawResponse = JSON.stringify(data);

    expect(response.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(data.type).toBe("error");
    expect(data.error.type).toBe("invalid_request_error");
    expect(data.error.message).toContain("moderator");
    expect(rawResponse).not.toContain(sensitiveContent);
    expect(rawResponse).not.toContain(upstreamKey);
    expect(rawResponse).not.toContain(token);
  });
});
