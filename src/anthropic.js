import { estimateTokensFromAnthropic } from "./tokens.js";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const SUPPORTED_INPUT_ROLES = new Set([
  "user",
  "assistant",
  "system",
  "developer",
  "tool",
  "function",
]);

const PERMITTED_UPSTREAM_ROLES = new Set(["user", "assistant"]);

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (block.type === "image") return "[image content]";
      if (block.type === "tool_result") {
        const nested = block.content ?? block.output;
        return typeof nested === "string" ? nested : textFromContent(nested);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractInstructionText(value, label = "system") {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be a string or an array of text blocks.`);
  }

  const parts = [];
  for (const block of value) {
    if (!isPlainObject(block) || block.type !== "text" || typeof block.text !== "string") {
      throw new TypeError(`Invalid ${label} content block: only text blocks with string text are supported.`);
    }
    if (block.text) parts.push(block.text);
  }
  return parts.join("\n").trim();
}

function anthropicImageToOpenAI(block) {
  const source = block?.source;
  if (!isPlainObject(source)) return null;

  if (source.type === "base64" && typeof source.data === "string" && source.data.trim()) {
    const mediaType = typeof source.media_type === "string" && source.media_type.trim()
      ? source.media_type.trim()
      : "image/png";
    return {
      type: "image_url",
      image_url: { url: `data:${mediaType};base64,${source.data.trim()}` },
    };
  }

  if (source.type === "url" && typeof source.url === "string" && source.url.trim()) {
    return { type: "image_url", image_url: { url: source.url.trim() } };
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

function toolResultContentToParts(rawContent) {
  if (rawContent === undefined || rawContent === null) {
    return { text: "", images: [] };
  }
  if (typeof rawContent === "string") {
    return { text: rawContent, images: [] };
  }
  if (Array.isArray(rawContent)) {
    const textLines = [];
    const images = [];
    for (const item of rawContent) {
      if (!isPlainObject(item) || typeof item.type !== "string") {
        throw new TypeError("Malformed content block inside tool result.");
      }
      if (item.type === "text") {
        if (typeof item.text !== "string") {
          throw new TypeError("Tool result text block must have a string text field.");
        }
        textLines.push(item.text);
      } else if (item.type === "image") {
        const mappedImage = anthropicImageToOpenAI(item);
        if (!mappedImage) {
          throw new TypeError("Unsupported or malformed image content block inside tool result.");
        }
        images.push(mappedImage);
      } else {
        throw new TypeError(
          `Unsupported content block type "${item.type.slice(0, 64)}" inside tool result.`,
        );
      }
    }
    return { text: textLines.join("\n"), images };
  }
  if (isPlainObject(rawContent)) {
    return { text: JSON.stringify(rawContent), images: [] };
  }
  if (typeof rawContent === "number" || typeof rawContent === "boolean") {
    return { text: String(rawContent), images: [] };
  }
  throw new TypeError("Malformed tool result content.");
}

function formatToolResultMessage({ id, name, text, isError = false, matched = true }) {
  const cleanName = typeof name === "string" && name.trim() ? name.trim() : "";
  const cleanId = typeof id === "string" && id.trim() ? id.trim() : "";

  let header;
  if (matched) {
    if (cleanName && cleanId) {
      header = `[Tool result: ${cleanName}, call_id=${cleanId}]`;
    } else if (cleanName) {
      header = `[Tool result: ${cleanName}]`;
    } else if (cleanId) {
      header = `[Tool result: call_id=${cleanId}]`;
    } else {
      header = "[Tool result]";
    }
  } else if (cleanName && cleanId) {
    header = `[Tool result (unmatched): ${cleanName}, call_id=${cleanId}]`;
  } else if (cleanName) {
    header = `[Tool result (unmatched): ${cleanName}]`;
  } else {
    header = `[Tool result (unmatched): call_id=${cleanId || "unknown"}]`;
  }

  const body = isError
    ? (text ? `[Tool error]\n${text}` : "[Tool error]")
    : text;

  return body ? `${header}\n${body}` : header;
}

function pushSystemInstruction(pendingSystemParts, text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) return;
  if (pendingSystemParts[pendingSystemParts.length - 1] !== trimmed) {
    pendingSystemParts.push(trimmed);
  }
}

function applySystemPrefixToUserText(userText, pendingSystemParts) {
  if (!pendingSystemParts.length) return userText;
  const instructions = pendingSystemParts.splice(0).join("\n\n");
  const systemBlock = `[System instructions]\n${instructions}`;
  if (!userText) return systemBlock;
  return `${systemBlock}\n\n[User message]\n${userText}`;
}

function buildUserMessage(textContent, imageParts, pendingSystemParts) {
  const finalText = applySystemPrefixToUserText(textContent, pendingSystemParts);
  if (imageParts.length > 0) {
    const parts = [];
    if (finalText.length > 0) {
      parts.push({ type: "text", text: finalText });
    }
    parts.push(...imageParts);
    return { role: "user", content: parts };
  }
  return { role: "user", content: finalText };
}

function normalizeOpenAIToolCalls(rawToolCalls, startIndex = 0) {
  if (rawToolCalls === undefined || rawToolCalls === null) return [];
  if (!Array.isArray(rawToolCalls)) {
    throw new TypeError("Assistant tool_calls must be an array.");
  }

  const normalized = [];
  for (const call of rawToolCalls) {
    if (!isPlainObject(call) || !isPlainObject(call.function)) {
      throw new TypeError("Each assistant tool_call must be an object with a function definition.");
    }
    const name = typeof call.function.name === "string" ? call.function.name.trim() : "";
    if (!name) {
      throw new TypeError("Each assistant tool_call must specify a non-empty function.name.");
    }
    const id = typeof call.id === "string" && call.id.trim()
      ? call.id.trim()
      : `call_${startIndex + normalized.length + 1}`;
    const rawArgs = call.function.arguments;
    const args = typeof rawArgs === "string"
      ? rawArgs
      : (isPlainObject(rawArgs) || Array.isArray(rawArgs)
        ? JSON.stringify(rawArgs)
        : JSON.stringify(rawArgs ?? {}));

    normalized.push({
      id,
      type: "function",
      function: { name, arguments: args },
    });
  }
  return normalized;
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
  const pendingSystemParts = [];
  let pendingSystemFromHistory = false;
  const pendingToolCalls = new Map();

  const topLevelSystemText = extractInstructionText(body.system, "system");
  if (topLevelSystemText) {
    pushSystemInstruction(pendingSystemParts, topLevelSystemText);
  }

  for (const message of body.messages) {
    if (!isPlainObject(message)) {
      throw new TypeError("Each message must be a JSON object.");
    }
    if (typeof message.role !== "string" || !message.role.trim()) {
      throw new TypeError("Each message must include a valid string role.");
    }

    const role = message.role.trim();
    if (!SUPPORTED_INPUT_ROLES.has(role)) {
      const safeRole = role.replace(/[^\w:-]/g, "").slice(0, 64) || "unknown";
      throw new TypeError(
        `Unsupported message role "${safeRole}". Each message role must be normalized from user, assistant, system, developer, tool, or function.`,
      );
    }

    if (role === "system" || role === "developer") {
      if (typeof message.content !== "string" && !Array.isArray(message.content)) {
        throw new TypeError(
          `Invalid content for message role "${role}": content must be a string or content-block array.`,
        );
      }
      if (Array.isArray(message.content) && message.content.length === 0) {
        throw new TypeError(`Message with role "${role}" must not have an empty content array.`);
      }
      const instructionText = extractInstructionText(message.content, role);
      if (!instructionText) {
        throw new TypeError(`Message with role "${role}" must contain non-empty instruction text.`);
      }
      pushSystemInstruction(pendingSystemParts, instructionText);
      if (messages.length > 0) {
        pendingSystemFromHistory = true;
      }
      continue;
    }

    if (role === "assistant") {
      if (pendingSystemFromHistory && pendingSystemParts.length > 0) {
        messages.push({
          role: "user",
          content: `[System instructions]\n${pendingSystemParts.splice(0).join("\n\n")}`,
        });
        pendingSystemFromHistory = false;
      }

      const textParts = [];
      const toolCalls = normalizeOpenAIToolCalls(message.tool_calls, 0);

      if (isPlainObject(message.function_call)) {
        const fnName = typeof message.function_call.name === "string"
          ? message.function_call.name.trim()
          : "";
        if (!fnName) {
          throw new TypeError("Assistant function_call must include a non-empty name.");
        }
        const rawArgs = message.function_call.arguments;
        const args = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? {});
        toolCalls.push({
          id: `call_${toolCalls.length + 1}`,
          type: "function",
          function: { name: fnName, arguments: args },
        });
      }

      const content = message.content;
      if (content === null || content === undefined) {
        if (toolCalls.length === 0) {
          throw new TypeError(
            "Assistant message with null content must include at least one valid tool call.",
          );
        }
      } else if (typeof content === "string") {
        if (content.length === 0 && toolCalls.length === 0) {
          throw new TypeError("Assistant message content must not be empty without tool calls.");
        }
        if (content.length > 0) textParts.push(content);
      } else if (Array.isArray(content)) {
        if (content.length === 0 && toolCalls.length === 0) {
          throw new TypeError("Assistant message content array must not be empty.");
        }
        for (const block of content) {
          if (!isPlainObject(block) || typeof block.type !== "string") {
            throw new TypeError("Each content block in assistant message must be a typed object.");
          }
          if (block.type === "text") {
            if (typeof block.text !== "string") {
              throw new TypeError("Assistant text block must have a string text property.");
            }
            if (block.text.length > 0) textParts.push(block.text);
          } else if (block.type === "tool_use") {
            const name = typeof block.name === "string" ? block.name.trim() : "";
            if (!name) {
              throw new TypeError("Assistant tool_use block must include a non-empty string name.");
            }
            const id = typeof block.id === "string" && block.id.trim()
              ? block.id.trim()
              : `call_${toolCalls.length + 1}`;
            const args = isPlainObject(block.input) || Array.isArray(block.input)
              ? JSON.stringify(block.input)
              : JSON.stringify(block.input ?? {});
            toolCalls.push({
              id,
              type: "function",
              function: { name, arguments: args },
            });
          } else if (block.type === "thinking" || block.type === "redacted_thinking") {
            // Thinking/redacted-thinking blocks are intentionally omitted from
            // upstream conversation history.
          } else {
            throw new TypeError(
              `Unsupported content block type "${block.type.slice(0, 64)}" in assistant message.`,
            );
          }
        }
      } else {
        throw new TypeError("Each message content must be a string or content-block array.");
      }

      const normalizeAssistantToolCallsToText = String(env.NORMALIZE_ASSISTANT_TOOL_CALLS ?? "0") === "1";
      if (normalizeAssistantToolCallsToText && toolCalls.length > 0) {
        for (const call of toolCalls) {
          textParts.push(
            `[Assistant tool call: ${call.function.name}, call_id=${call.id}]\nArguments: ${call.function.arguments}`,
          );
        }
      }

      const joinedText = textParts.join("\n");
      const assistantMessage = {
        role: "assistant",
        content: joinedText.length > 0 ? joinedText : null,
      };
      if (toolCalls.length > 0 && !normalizeAssistantToolCallsToText) {
        assistantMessage.tool_calls = toolCalls;
      }

      if (assistantMessage.content === null && (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0)) {
        throw new TypeError("Assistant message produced no valid text content or tool calls.");
      }

      messages.push(assistantMessage);
      pendingToolCalls.clear();
      for (const call of toolCalls) {
        pendingToolCalls.set(call.id, call.function.name);
      }
      continue;
    }

    if (role === "tool") {
      const rawContent = message.content !== undefined ? message.content : message.output;
      if (rawContent === undefined || rawContent === null) {
        throw new TypeError('Message with role "tool" must include non-null content.');
      }
      const { text: resultText, images } = toolResultContentToParts(rawContent);
      const callId = typeof message.tool_call_id === "string" && message.tool_call_id.trim()
        ? message.tool_call_id.trim()
        : (typeof message.id === "string" && message.id.trim() ? message.id.trim() : "");

      const matched = Boolean(callId && pendingToolCalls.has(callId));
      const matchedName = matched ? pendingToolCalls.get(callId) : "";
      if (matched) pendingToolCalls.delete(callId);

      const explicitName = typeof message.name === "string" && message.name.trim()
        ? message.name.trim()
        : "";
      const toolName = explicitName || matchedName;

      const formatted = formatToolResultMessage({
        id: callId,
        name: toolName,
        text: resultText,
        isError: Boolean(message.is_error),
        matched,
      });

      messages.push(buildUserMessage(formatted, images, pendingSystemParts));
      pendingSystemFromHistory = false;
      continue;
    }

    if (role === "function") {
      const fnName = typeof message.name === "string" ? message.name.trim() : "";
      if (!fnName) {
        throw new TypeError('Message with role "function" must include a non-empty string name.');
      }
      const rawContent = message.content !== undefined ? message.content : message.output;
      if (rawContent === undefined || rawContent === null) {
        throw new TypeError('Message with role "function" must include non-null content.');
      }
      const { text: resultText, images } = toolResultContentToParts(rawContent);
      const callId = typeof message.tool_call_id === "string" && message.tool_call_id.trim()
        ? message.tool_call_id.trim()
        : "";

      if (callId && pendingToolCalls.has(callId)) {
        pendingToolCalls.delete(callId);
      } else {
        for (const [pendingId, pendingName] of pendingToolCalls.entries()) {
          if (pendingName === fnName) {
            pendingToolCalls.delete(pendingId);
            break;
          }
        }
      }

      const formatted = formatToolResultMessage({
        id: callId,
        name: fnName,
        text: resultText,
        isError: Boolean(message.is_error),
        matched: true,
      });

      messages.push(buildUserMessage(formatted, images, pendingSystemParts));
      pendingSystemFromHistory = false;
      continue;
    }

    // role === "user"
    const content = message.content;
    if (typeof content === "string") {
      pendingToolCalls.clear();
      messages.push(buildUserMessage(content, [], pendingSystemParts));
      pendingSystemFromHistory = false;
      continue;
    }

    if (!Array.isArray(content)) {
      throw new TypeError("Each message content must be a string or content-block array.");
    }
    if (content.length === 0) {
      throw new TypeError("User message content array must not be empty.");
    }

    const textSegments = [];
    const imageParts = [];

    for (const block of content) {
      if (!isPlainObject(block) || typeof block.type !== "string") {
        throw new TypeError("Each content block in user message must be a typed object.");
      }

      if (block.type === "text") {
        if (typeof block.text !== "string") {
          throw new TypeError("User text block must have a string text property.");
        }
        if (block.text.length > 0) {
          textSegments.push(block.text);
        }
      } else if (block.type === "image") {
        const mappedImage = anthropicImageToOpenAI(block);
        if (!mappedImage) {
          throw new TypeError("Unsupported or malformed image content block.");
        }
        imageParts.push(mappedImage);
      } else if (block.type === "tool_result") {
        const callId = typeof block.tool_use_id === "string" && block.tool_use_id.trim()
          ? block.tool_use_id.trim()
          : (typeof block.tool_call_id === "string" && block.tool_call_id.trim()
            ? block.tool_call_id.trim()
            : "");
        const matched = Boolean(callId && pendingToolCalls.has(callId));
        const matchedName = matched ? pendingToolCalls.get(callId) : "";
        if (matched) pendingToolCalls.delete(callId);

        const explicitName = typeof block.name === "string" && block.name.trim()
          ? block.name.trim()
          : "";
        const toolName = explicitName || matchedName;

        const { text: resultText, images: nestedImages } = toolResultContentToParts(
          block.content !== undefined ? block.content : (block.output ?? ""),
        );
        if (nestedImages.length > 0) {
          imageParts.push(...nestedImages);
        }

        const formatted = formatToolResultMessage({
          id: callId,
          name: toolName,
          text: resultText,
          isError: Boolean(block.is_error),
          matched,
        });
        textSegments.push(formatted);
      } else {
        throw new TypeError(
          `Unsupported content block type "${block.type.slice(0, 64)}" in user message.`,
        );
      }
    }

    pendingToolCalls.clear();

    const combinedText = textSegments.join("\n");
    if (combinedText.length === 0 && imageParts.length === 0 && pendingSystemParts.length === 0) {
      throw new TypeError("User message produced no valid text or image content.");
    }

    messages.push(buildUserMessage(combinedText, imageParts, pendingSystemParts));
    pendingSystemFromHistory = false;
  }

  if (pendingSystemParts.length > 0) {
    const systemOnlyMessage = {
      role: "user",
      content: `[System instructions]\n${pendingSystemParts.splice(0).join("\n\n")}`,
    };
    if (messages.length > 0 && !pendingSystemFromHistory) {
      messages.unshift(systemOnlyMessage);
    } else {
      messages.push(systemOnlyMessage);
    }
  }

  if (messages.length === 0) {
    throw new TypeError("Request must produce at least one upstream message.");
  }

  for (const msg of messages) {
    if (!isPlainObject(msg) || !PERMITTED_UPSTREAM_ROLES.has(msg.role)) {
      throw new Error("Upstream role policy violation: only user and assistant roles are permitted.");
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
