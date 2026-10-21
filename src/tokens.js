function contentText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((block) => {
    if (block?.type === "text" && typeof block.text === "string") return block.text;
    if (block?.type === "tool_result") {
      const content = block.content ?? block.output ?? "";
      return typeof content === "string" ? content : JSON.stringify(content);
    }
    if (block?.type === "image") return "[image]";
    return "";
  }).join("\n");
}

export function estimateTokensFromAnthropic(body, env = {}) {
  const parsed = Number(env.ESTIMATE_TOKENS_PER_CHAR ?? 0.25);
  const tokensPerChar = Number.isFinite(parsed) && parsed > 0 ? parsed : 0.25;
  const parts = [contentText(body?.system)];

  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    parts.push(contentText(message?.content));
  }

  return Math.max(0, Math.floor(parts.join("\n").length * tokensPerChar));
}
