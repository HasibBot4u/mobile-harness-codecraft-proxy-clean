import { describe, expect, it } from "vitest";
import { authorizeRequest, readClientToken, safeEqual } from "../src/auth.js";

function request(headers = {}) {
  return new Request("https://worker.test/v1/messages", { headers });
}

describe("authentication helpers", () => {
  it("reads x-api-key used by Mobile Harness", () => {
    expect(readClientToken(request({ "x-api-key": "mobile-token" }))).toBe("mobile-token");
  });

  it("accepts the bearer header and proxy-token header", () => {
    expect(readClientToken(request({ authorization: "Bearer from-bearer" }))).toBe("from-bearer");
    expect(readClientToken(request({ "proxy-token": "from-proxy-header" }))).toBe("from-proxy-header");
  });

  it("fails closed when the configured secret is missing", () => {
    expect(authorizeRequest(request({ "x-api-key": "anything" }), { REQUIRE_PROXY_TOKEN: "1" }).ok).toBe(false);
  });

  it("accepts only the exact configured proxy token", () => {
    const env = { REQUIRE_PROXY_TOKEN: "1", PROXY_TOKEN: "expected" };
    expect(authorizeRequest(request({ "x-api-key": "expected" }), env).ok).toBe(true);
    expect(authorizeRequest(request({ "x-api-key": "wrong" }), env).ok).toBe(false);
  });

  it("compares equal strings and rejects unequal strings", () => {
    expect(safeEqual("same", "same")).toBe(true);
    expect(safeEqual("same", "samf")).toBe(false);
    expect(safeEqual("same", "same-longer")).toBe(false);
  });
});
