const STATUS_TO_TYPE = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  408: "timeout_error",
  413: "request_too_large",
  422: "invalid_request_error",
  429: "rate_limit_error",
  500: "api_error",
  502: "api_error",
  503: "overloaded_error",
  504: "timeout_error",
};

export function anthropicError(status, message, type) {
  return {
    type: "error",
    error: {
      type: type || STATUS_TO_TYPE[status] || "api_error",
      message: String(message || "Request failed."),
    },
  };
}

export async function upstreamErrorMessage(response) {
  const raw = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(raw);
    return String(
      parsed?.error?.message || parsed?.message || parsed?.error || raw || `Upstream returned HTTP ${response.status}.`,
    );
  } catch {
    return raw || `Upstream returned HTTP ${response.status}.`;
  }
}
