import { authorizeRequest } from "./auth.js";
import { anthropicRequestToOpenAI, openAIResponseToAnthropic, estimateInputTokens } from "./anthropic.js";
import { anthropicError, upstreamErrorMessage } from "./errors.js";
import { openAIStreamToAnthropic } from "./streaming.js";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, x-api-key, anthropic-api-key, anthropic-version, anthropic-beta, proxy-token",
  "access-control-expose-headers": "x-request-id",
};

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "anthropic-version": "2023-06-01",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function withCORS(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  headers.set("anthropic-version", "2023-06-01");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function validateUpstreamBase(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("UPSTREAM_BASE_URL is not configured.");
  }

  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("UPSTREAM_BASE_URL is not a valid URL.");
  }

  if (url.protocol !== "https:") {
    throw new Error("UPSTREAM_BASE_URL must use HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("UPSTREAM_BASE_URL cannot contain credentials, a query string, or a fragment.");
  }

  const base = url.toString().replace(/\/+$/, "");
  return base;
}

function routeAuth(request, env) {
  const result = authorizeRequest(request, env);
  if (result.ok) return null;
  return jsonResponse(result.error, 401);
}


async function readLimitedJson(request, env) {
  const maxBytes = Number(env.MAX_REQUEST_BYTES || 20_000_000);
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > maxBytes) {
    const error = new Error("Request body exceeds the configured limit.");
    error.statusCode = 413;
    throw error;
  }
  if (!request.body) {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("Request body exceeds the configured limit.").catch(() => {});
        const error = new Error("Request body exceeds the configured limit.");
        error.statusCode = 413;
        throw error;
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

function requestJsonError(error) {
  const status = error?.statusCode === 413 ? 413 : 400;
  return jsonResponse(anthropicError(status, error instanceof Error ? error.message : String(error)), status);
}

function safeUpstreamStatus(status) {
  if ([400, 401, 403, 404, 408, 413, 422, 429].includes(status)) return status;
  if (status >= 500 && status <= 599) return status;
  return 502;
}

async function handleModelList(request, env) {
  const authError = routeAuth(request, env);
  if (authError) return authError;

  let base;
  try {
    base = validateUpstreamBase(env.UPSTREAM_BASE_URL);
  } catch (error) {
    return jsonResponse(anthropicError(500, error.message), 500);
  }

  if (!env.UPSTREAM_API_KEY) {
    return jsonResponse(anthropicError(500, "UPSTREAM_API_KEY secret is missing."), 500);
  }

  try {
    const response = await fetch(`${base}/models`, {
      method: "GET",
      headers: { authorization: `Bearer ${env.UPSTREAM_API_KEY}` },
      signal: request.signal,
    });
    if (!response.ok) {
      const message = await upstreamErrorMessage(response);
      return jsonResponse(anthropicError(safeUpstreamStatus(response.status), message), safeUpstreamStatus(response.status));
    }
    return withCORS(new Response(response.body, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") || "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    }));
  } catch (error) {
    return jsonResponse(anthropicError(502, error instanceof Error ? error.message : String(error)), 502);
  }
}

async function handleCountTokens(request, env) {
  const authError = routeAuth(request, env);
  if (authError) return authError;

  let body;
  try {
    body = await readLimitedJson(request, env);
  } catch (error) {
    return requestJsonError(error);
  }

  return jsonResponse({ input_tokens: estimateInputTokens(body, env) });
}

async function handleMessages(request, env) {
  const authError = routeAuth(request, env);
  if (authError) return authError;

  if (!env.UPSTREAM_API_KEY) {
    return jsonResponse(anthropicError(500, "UPSTREAM_API_KEY secret is missing."), 500);
  }

  let body;
  try {
    body = await readLimitedJson(request, env);
  } catch (error) {
    return requestJsonError(error);
  }

  let converted;
  try {
    converted = anthropicRequestToOpenAI(body, env);
  } catch (error) {
    return jsonResponse(anthropicError(400, error instanceof Error ? error.message : String(error)), 400);
  }

  let base;
  try {
    base = validateUpstreamBase(env.UPSTREAM_BASE_URL);
  } catch (error) {
    return jsonResponse(anthropicError(500, error.message), 500);
  }

  let upstream;
  try {
    upstream = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.UPSTREAM_API_KEY}`,
        "content-type": "application/json",
        accept: converted.payload.stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(converted.payload),
      signal: request.signal,
    });
  } catch (error) {
    return jsonResponse(anthropicError(502, error instanceof Error ? error.message : String(error)), 502);
  }

  if (!upstream.ok) {
    const message = await upstreamErrorMessage(upstream);
    const status = safeUpstreamStatus(upstream.status);
    return jsonResponse(anthropicError(status, message), status);
  }

  if (converted.payload.stream) {
    if (!upstream.body) {
      return jsonResponse(anthropicError(502, "Upstream did not return a streaming response body."), 502);
    }
    const upstreamContentType = (upstream.headers.get("content-type") || "").toLowerCase();
    if (!upstreamContentType.includes("text/event-stream")) {
      return jsonResponse(anthropicError(502, "Upstream did not return text/event-stream for a streaming request."), 502);
    }

    const stream = openAIStreamToAnthropic(upstream.body, {
      model: converted.mappedModel,
      inputTokens: estimateInputTokens(body, env),
      tokensPerChar: Number(env.ESTIMATE_TOKENS_PER_CHAR || 0.25),
    });

    return withCORS(new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    }));
  }

  let data;
  try {
    data = await upstream.json();
  } catch {
    return jsonResponse(anthropicError(502, "Upstream returned invalid JSON."), 502);
  }

  try {
    const output = openAIResponseToAnthropic(
      data,
      converted.mappedModel,
      estimateInputTokens(body, env),
    );
    return jsonResponse(output, 200, {
      "x-request-id": typeof data.id === "string" ? data.id : "",
    });
  } catch (error) {
    return jsonResponse(anthropicError(502, error instanceof Error ? error.message : String(error)), 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCORS(new Response(null, { status: 204 }));
    }

    if (url.pathname === "/health" && request.method === "GET") {
      const ready = Boolean(env.PROXY_TOKEN && env.UPSTREAM_API_KEY && env.UPSTREAM_BASE_URL);
      return jsonResponse({ ok: ready, service: "mobile-harness-codecraft-proxy" }, ready ? 200 : 503);
    }

    if (url.pathname === "/" && request.method === "GET") {
      return jsonResponse({
        name: "Mobile Harness CodeCraft Proxy",
        ok: true,
        endpoints: ["/v1/messages", "/v1/messages/count_tokens", "/v1/models", "/health"],
      });
    }

    if (url.pathname === "/v1/models" && request.method === "GET") {
      return handleModelList(request, env);
    }

    if (url.pathname === "/v1/messages/count_tokens" && request.method === "POST") {
      return handleCountTokens(request, env);
    }

    if (url.pathname === "/v1/messages" && request.method === "POST") {
      return handleMessages(request, env);
    }

    return jsonResponse(anthropicError(404, "Route not found."), 404);
  },
};
