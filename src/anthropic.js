import { estimateTokensFromAnthropic } from "./tokens.js";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (block.type === "image") return "[image content]";
      if (block.type === "tool_result") {
        const nested = block.content;
        return typeof nested === "string" ? nested : textFromContent(nested);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function anthropicImageToOpenAI(block) {
  const source = block?.source;
  if (!source || typeof source !== "object") return null;

  if (source.type === "base64" && typeof source.data === "string" && source.data) {
    const mediaType = typeof source.media_type === "string" ? source.media_type : "image/png";
    return {
      type: "image_url",
      image_url: { url: `data:${mediaType};base64,${source.data}` },
    };
  }

  if (source.type === "url" && typeof source.url === "string" && source.url) {
    return { type: "image_url", image_url: { url: source.url } };
  }

  return null;
}

function mapToolChoice(choice) {
  if (typeof choice === "string") {
    if (["auto", "none", "required"].includes(choice)) return choice;
    return "auto";
  }

  if (!isPlainObject(choice)) return undefined;
  if (choice.type === "auto") return "auto";
  if (choice.type === "none") return "none";
  if (choice.type === "any") return "required";
  if (choice.type === "tool" && typeof choice.name === "string") {
    return { type: "function", function: { name: choice.name } };
  }

  return undefined;
}

function mapToolDefinitions(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool) => tool && typeof tool.name === "string" && tool.name)
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: isPlainObject(tool.input_schema)
          ? tool.input_schema
          : { type: "object", properties: {} },
      },
    }));
}

function toolResultAsText(block) {
  const value = block?.content ?? block?.output ?? "";
  if (typeof value === "string") return value;
  return textFromContent(value) || JSON.stringify(value);
}

function serializeUnmatchedToolResult(block) {
  return `[Tool result for ${block?.tool_use_id || "unknown tool"}]\n${toolResultAsText(block)}`;
}

/** Convert Anthropic Messages request bodies to OpenAI Chat Completions bodies. */
export function anthropicRequestToOpenAI(body, env = {}) {
  if (!isPlainObject(body)) throw new TypeError("Request body must be a JSON object.");
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new TypeError("messages must be a non-empty array.");
  }

  const map = parseModelMap(env.MODEL_MAP_JSON);
  const requestedModel = typeof body.model === "string" && body.model.trim()
    ? body.model.trim()
    : (env.DEFAULT_MODEL || "claude-opus-5.5");
  const model = map[requestedModel] || requestedModel;

  const messages = [];
  const systemText = textFromContent(body.system);
  if (systemText) messages.push({ role: "system", content: systemText });

  for (const message of body.messages) {
    if (!message || !["user", "assistant"].includes(message.role)) {
      throw new TypeError("Each message role must be user or assistant.");
    }

    const content = message.content;
    if (typeof content === "string") {
      messages.push({ role: message.role, content });
      continue;
    }

    if (!Array.isArray(content)) {
      throw new TypeError("Each message content must be a string or content-block array.");
    }

    if (message.role === "assistant") {
      const textParts = [];
      const toolCalls = [];

      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          const id = typeof block.id === "string" && block.id
            ? block.id
            : `call_${toolCalls.length + 1}`;
          const name = typeof block.name === "string" && block.name ? block.name : "unknown_tool";
          const args = isPlainObject(block.input) || Array.isArray(block.input)
            ? JSON.stringify(block.input)
            : JSON.stringify(block.input ?? {});
          toolCalls.push({
            id,
            type: "function",
            function: { name, arguments: args },
          });
        }
        // Thinking/redacted-thinking blocks are intentionally not copied into
        // a provider's normal conversation history.
      }

      const assistantMessage = {
        role: "assistant",
        content: textParts.join("\n") || null,
      };
      if (toolCalls.length) assistantMessage.tool_calls = toolCalls;
      if (assistantMessage.content !== null || toolCalls.length) messages.push(assistantMessage);
      continue;
    }

    const textParts = [];
    const imageParts = [];
    const toolResults = [];

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      } else if (block.type === "image") {
        const mappedImage = anthropicImageToOpenAI(block);
        if (mappedImage) imageParts.push(mappedImage);
      } else if (block.type === "tool_result") {
        toolResults.push(block);
      }
    }

    // OpenAI-compatible providers require tool messages directly after the
    // assistant message containing the matching tool_calls. Unmatched results
    // are represented as text instead of emitting an invalid orphan tool role.
    const previous = messages[messages.length - 1];
    const pendingIds = new Set(
      previous?.role === "assistant" && Array.isArray(previous.tool_calls)
        ? previous.tool_calls.map((call) => call.id)
        : [],
    );
    const matched = [];
    const unmatched = [];

    for (const result of toolResults) {
      const id = result?.tool_use_id;
      if (typeof id === "string" && pendingIds.has(id)) {
        const toolContent = toolResultAsText(result);
        matched.push({
          role: "tool",
          tool_call_id: id,
          content: result?.is_error ? `[Tool error]
${toolContent}` : toolContent,
        });
        pendingIds.delete(id);
      } else {
        unmatched.push(serializeUnmatchedToolResult(result));
      }
    }

    for (const toolMessage of matched) messages.push(toolMessage);
    textParts.push(...unmatched);

    const hasUserText = textParts.join("\n").trim().length > 0;
    if (imageParts.length) {
      const parts = [];
      if (hasUserText) parts.push({ type: "text", text: textParts.join("\n") });
      parts.push(...imageParts);
      messages.push({ role: "user", content: parts });
    } else if (hasUserText) {
      messages.push({ role: "user", content: textParts.join("\n") });
    }
  }

  const result = {
    model,
    messages,
    stream: body.stream === true,
    max_tokens: Number.isInteger(body.max_tokens) && body.max_tokens > 0
      ? body.max_tokens
      : undefined,
  };

  if (typeof body.temperature === "number") result.temperature = body.temperature;
  if (typeof body.top_p === "number") result.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) result.stop = body.stop_sequences;

  const tools = mapToolDefinitions(body.tools);
  if (tools.length) result.tools = tools;
  const toolChoice = mapToolChoice(body.tool_choice);
  if (toolChoice !== undefined && tools.length) result.tool_choice = toolChoice;

  // Undefined fields disappear during JSON serialization.
  return { payload: result, requestedModel, mappedModel: model };
}

function parseModelMap(raw) {
  if (!raw || typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function usageToAnthropic(usage, fallbackInput, fallbackOutput) {
  return {
    input_tokens: Number.isFinite(usage?.prompt_tokens)
      ? usage.prompt_tokens
      : fallbackInput,
    output_tokens: Number.isFinite(usage?.completion_tokens)
      ? usage.completion_tokens
      : fallbackOutput,
  };
}

function parseToolArguments(raw) {
  if (isPlainObject(raw) || Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

function responseTextBlocks(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (typeof part === "string") return [{ type: "text", text: part }];
    if (part?.type === "text" && typeof part.text === "string") {
      return [{ type: "text", text: part.text }];
    }
    return [];
  });
}

export function openAIResponseToAnthropic(data, requestedModel, fallbackInputTokens = 0) {
  const choice = data?.choices?.[0];
  if (!choice || !choice.message) {
    throw new TypeError("Upstream response did not contain choices[0].message.");
  }

  const message = choice.message;
  const content = responseTextBlocks(message.content);
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (call?.type !== "function" && !call?.function) continue;
    content.push({
      type: "tool_use",
      id: typeof call.id === "string" && call.id ? call.id : "toolu_missing_id",
      name: typeof call.function?.name === "string" ? call.function.name : "unknown_tool",
      input: parseToolArguments(call.function?.arguments),
    });
  }

  const finishReason = choice.finish_reason;
  const stopReason = finishReason === "length"
    ? "max_tokens"
    : (finishReason === "tool_calls" || (message.tool_calls || []).length > 0)
      ? "tool_use"
      : "end_turn";

  const outputText = content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const estimatedOutput = Math.floor(outputText.length * 0.25);
  const usage = usageToAnthropic(
    data.usage,
    fallbackInputTokens,
    estimatedOutput,
  );

  return {
    id: typeof data.id === "string" ? data.id : `msg_${crypto.randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    model: typeof data.model === "string" ? data.model : requestedModel,
    content: content.length ? content : [{ type: "text", text: "" }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}

export function estimateInputTokens(body, env) {
  return estimateTokensFromAnthropic(body, env);
}
