import { anthropicError } from "./errors.js";

function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function usageFromOpenAI(usage, inputFallback, outputFallback) {
  return {
    input_tokens: Number.isFinite(usage?.prompt_tokens) ? usage.prompt_tokens : inputFallback,
    output_tokens: Number.isFinite(usage?.completion_tokens) ? usage.completion_tokens : outputFallback,
  };
}

function stopReason(finishReason, hasTools) {
  if (finishReason === "length") return "max_tokens";
  if (finishReason === "tool_calls" || hasTools) return "tool_use";
  return "end_turn";
}

/**
 * Convert OpenAI-compatible SSE to Anthropic Messages SSE.
 * Text is forwarded incrementally. Tool arguments are kept per tool index and
 * emitted as complete block payloads after the upstream stream finishes. This
 * avoids interleaved parallel tool deltas targeting a block that was already
 * stopped. It deliberately trades tool-argument token-by-token visibility for
 * a well-formed Anthropic block sequence.
 */
export function openAIStreamToAnthropic(upstreamBody, options = {}) {
  const model = options.model || "claude-opus-5.5";
  const inputFallback = Number(options.inputTokens || 0);
  const tokensPerChar = Number(options.tokensPerChar || 0.25);

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let activeReader = null;
  let cancelled = false;

  return new ReadableStream({
    async start(controller) {
      const reader = upstreamBody.getReader();
      activeReader = reader;
      let buffer = "";
      let started = false;
      let textBlockOpen = false;
      let nextBlockIndex = 0;
      let outputCharCount = 0;
      let finishReason = null;
      let finalUsage = null;
      let streamError = null;
      let doneSignal = false;
      const tools = new Map();

      const send = (event, data) => {
        if (cancelled) return;
        controller.enqueue(encoder.encode(sseFrame(event, data)));
      };

      const ensureStarted = () => {
        if (started) return;
        started = true;
        send("message_start", {
          type: "message_start",
          message: {
            id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: inputFallback, output_tokens: 0 },
          },
        });
        send("ping", { type: "ping" });
      };

      const ensureTextBlock = () => {
        ensureStarted();
        if (textBlockOpen) return;
        send("content_block_start", {
          type: "content_block_start",
          index: nextBlockIndex,
          content_block: { type: "text", text: "" },
        });
        textBlockOpen = true;
      };

      const emitText = (text) => {
        if (typeof text !== "string" || !text) return;
        ensureTextBlock();
        outputCharCount += text.length;
        send("content_block_delta", {
          type: "content_block_delta",
          index: nextBlockIndex,
          delta: { type: "text_delta", text },
        });
      };

      const closeTextBlock = () => {
        if (!textBlockOpen) return;
        send("content_block_stop", {
          type: "content_block_stop",
          index: nextBlockIndex,
        });
        textBlockOpen = false;
        nextBlockIndex += 1;
      };

      const parseFrame = (frame) => {
        const dataLines = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""));
        if (!dataLines.length) return;
        const raw = dataLines.join("\n").trim();
        if (!raw) return;
        if (raw === "[DONE]") {
          doneSignal = true;
          return;
        }

        let chunk;
        try {
          chunk = JSON.parse(raw);
        } catch {
          return;
        }

        if (chunk?.error) {
          streamError = String(chunk.error.message || "Upstream streaming error.");
          return;
        }

        if (chunk?.usage && typeof chunk.usage === "object") finalUsage = chunk.usage;
        const choice = chunk?.choices?.[0];
        if (!choice) return;

        const delta = choice.delta || {};
        emitText(delta.content);

        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) {
            const index = Number.isInteger(call.index) ? call.index : 0;
            const current = tools.get(index) || {
              index,
              id: "",
              name: "",
              args: "",
            };

            if (typeof call.id === "string" && call.id) current.id = call.id;
            if (typeof call.function?.name === "string") current.name += call.function.name;
            if (typeof call.function?.arguments === "string") current.args += call.function.arguments;
            tools.set(index, current);
          }
        }

        if (typeof choice.finish_reason === "string" && choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      };

      try {
        while (!doneSignal) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() || "";
          for (const frame of frames) {
            parseFrame(frame);
            if (doneSignal) break;
          }
        }

        buffer += decoder.decode();
        if (buffer.trim() && !doneSignal) parseFrame(buffer);

        ensureStarted();
        closeTextBlock();

        if (streamError) {
          send("error", anthropicError(502, streamError));
        } else {
          for (const [, tool] of [...tools.entries()].sort((a, b) => a[0] - b[0])) {
            const index = nextBlockIndex++;
            send("content_block_start", {
              type: "content_block_start",
              index,
              content_block: {
                type: "tool_use",
                id: tool.id || `toolu_${crypto.randomUUID().replaceAll("-", "")}`,
                name: tool.name || "unknown_tool",
                input: {},
              },
            });
            send("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: {
                type: "input_json_delta",
                partial_json: tool.args || "{}",
              },
            });
            send("content_block_stop", {
              type: "content_block_stop",
              index,
            });
          }
        }

        if (!textBlockOpen && nextBlockIndex === 0 && tools.size === 0 && !streamError) {
          const index = nextBlockIndex++;
          send("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "text", text: "" },
          });
          send("content_block_stop", { type: "content_block_stop", index });
        }

        const usage = usageFromOpenAI(
          finalUsage,
          inputFallback,
          Math.floor(outputCharCount * tokensPerChar),
        );
        send("message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: streamError ? "end_turn" : stopReason(finishReason, tools.size > 0),
            stop_sequence: null,
          },
          usage,
        });
        send("message_stop", { type: "message_stop" });
        controller.close();
      } catch (error) {
        if (!cancelled) {
          try {
            ensureStarted();
            closeTextBlock();
            send("error", anthropicError(502, error instanceof Error ? error.message : String(error)));
            send("message_delta", {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { input_tokens: inputFallback, output_tokens: Math.floor(outputCharCount * tokensPerChar) },
            });
            send("message_stop", { type: "message_stop" });
          } catch {
            // The client may have cancelled while this event was being enqueued.
          }
        }
      } finally {
        try { reader.releaseLock(); } catch { /* already released */ }
        if (!cancelled) {
          try { controller.close(); } catch { /* stream may already be closed */ }
        }
      }
    },
    async cancel(reason) {
      cancelled = true;
      try {
        await activeReader?.cancel(reason);
      } catch {
        // Upstream may already be closed.
      }
    },
  });
}
