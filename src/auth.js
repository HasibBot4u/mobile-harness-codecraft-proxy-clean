/** Read a supported bearer-style credential from an Anthropic client request. */
export function readClientToken(request) {
  const headers = request.headers;
  const dedicated = headers.get("proxy-token") || "";
  const anthropic = headers.get("anthropic-api-key") || "";
  const xApiKey = headers.get("x-api-key") || "";
  const authorization = headers.get("authorization") || "";
  const bearer = /^Bearer\s+/i.test(authorization)
    ? authorization.replace(/^Bearer\s+/i, "").trim()
    : "";

  return dedicated || anthropic || xApiKey || bearer;
}

/**
 * Compare a supplied token against a configured token without an early exit
 * for the first differing character. A length mismatch still returns early;
 * this is a practical comparison helper, not a formal side-channel guarantee.
 */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function isProxyAuthEnabled(env) {
  return String(env?.REQUIRE_PROXY_TOKEN ?? "1") === "1";
}

export function authorizeRequest(request, env) {
  if (!isProxyAuthEnabled(env)) {
    return { ok: true, error: null };
  }

  const expected = typeof env?.PROXY_TOKEN === "string" ? env.PROXY_TOKEN : "";
  const supplied = readClientToken(request);

  if (!expected || !supplied || !safeEqual(supplied, expected)) {
    return {
      ok: false,
      error: {
        type: "error",
        error: {
          type: "authentication_error",
          message: "Invalid or missing proxy token.",
        },
      },
    };
  }

  return { ok: true, error: null };
}
