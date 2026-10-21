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
});
