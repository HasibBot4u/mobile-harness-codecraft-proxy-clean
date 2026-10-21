# Mobile Harness CodeCraft Proxy — Role-Normalization Bug Fix

Resolve the production `"API Error: 400 Each message role must be user or assistant."` failure when sending real messages from Mobile Harness through the Cloudflare Worker proxy to CodeCraft's Chat Completions API.

### User Review & Critical Decisions

> [!IMPORTANT]
> Real Mobile Harness requests include top-level `system` instructions, in-history `system` / `developer` messages, and `tool` / `function` execution results. Because CodeCraft's `/v1/chat/completions` endpoint strictly accepts only `"user"` and `"assistant"` roles, the proxy must normalize all non-assistant roles into structured `"user"` messages before serialization while keeping `"assistant"` turns and tool-call metadata intact.

- **Confirmed Decision 1 — Strict Upstream Role Policy (`user` and `assistant` only)**: Enforce an explicit normalization layer and final serialization invariant so `payload.messages` sent to CodeCraft never contains `"system"`, `"developer"`, `"tool"`, `"function"`, or any other unsupported role.
- **Confirmed Decision 2 — System & Developer Instruction Merging**: Merge top-level `system` prompts and in-history `system` / `developer` messages into the corresponding `"user"` message under a `[System instructions]` prefix (`[System instructions]\n...\n\n[User message]\n...`), or emit a standalone `"user"` instruction message when no user message follows, without reordering conversation turns.
- **Confirmed Decision 3 — Tool Result & Historical Tool/Function Normalization**: Convert Anthropic `tool_result` blocks and historical `role: "tool"` / `role: "function"` messages into structured `"user"` context messages (`[Tool result: <name>, call_id=<id>]\n<output>`), while explicitly distinguishing orphan/unmatched results (`[Tool result (unmatched): call_id=<id>]\n<output>`) and preserving assistant `tool_calls` (including `content: null`).

---

### 1. Overview & Core Concept

- **What It Does**: Translates Anthropic Messages API requests from Mobile Harness / Claude Code into CodeCraft-compatible OpenAI Chat Completions requests where every serialized message role is guaranteed to be `"user"` or `"assistant"`.
- **Target Audience / Persona**: Developers using Mobile Harness or Claude Code connected to a self-hosted Cloudflare Worker proxy backed by CodeCraft (`https://codecraftapi.com/v1`).
- **Key Value**: Eliminates the HTTP 400 role rejection on real agent prompts, multi-turn conversations, and tool-use loops without losing system instructions, tool outputs, images, or security guarantees.

---

### 2. User Experience & Visual Design

- **Key User Flows**:
  1. **Connection & Health Check**: Mobile Harness queries `/health` and `/v1/models` using the configured proxy token; the Worker validates credentials and proxies model listings without exposing secrets.
  2. **System-Guided Prompt Turn**: Mobile Harness sends `POST /v1/messages` with a top-level `system` prompt and user message; the Worker merges the system instructions into the first user message with clear section headers and returns a valid Anthropic message or SSE stream.
  3. **Multi-Turn Tool Execution Loop**: Mobile Harness sends an assistant `tool_use` turn followed by a user `tool_result` (or historical `tool` / `function` messages); the Worker preserves the assistant's `tool_calls`, converts the tool results into labelled `"user"` context messages in exact chronological order, and streams or returns the next assistant response.
  4. **Safe Malformed / Unsupported Role Handling**: If a request includes an unrecognized role (e.g., `"moderator"`) or malformed content block, the Worker immediately responds with an Anthropic-formatted `400 invalid_request_error` naming only the invalid role or block type and never leaking credentials or private prompt text.
- **Visual Identity & Theme**:
  - *Aesthetic Direction*: Headless protocol-translation Cloudflare Worker with clean JSON and SSE wire contracts conforming to the Anthropic Messages API (`2023-06-01`).
  - *Color Palette & Mood*: N/A (headless edge proxy service; structured JSON/SSE responses).
  - *Typography & Hierarchy*: Deterministic plain-text delimiter headers (`[System instructions]`, `[User message]`, `[Tool result: <name>, call_id=<id>]`, `[Tool result (unmatched): call_id=<id>]`, `[Tool error]`) inside normalized message payloads for unambiguous LLM comprehension.
  - *Component Styling & Layout*: Modular request validation, role normalization, token estimation, and SSE stream transformation layers.
- **Interactive Feedback & Motion**: Real-time SSE event framing (`message_start`, `ping`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`) with buffered tool-argument emission to prevent interleaved block index collisions.

---

### 3. Key Product Decisions & Trade-Offs

- **Decision 1 — Merging System & Developer Instructions into User Messages**:
  - *Chosen Approach*: Accumulate top-level `system` and leading `"system"` / `"developer"` messages and prefix them onto the first `"user"` message as `[System instructions]\n...\n\n[User message]\n...`. Mid-conversation `"system"` / `"developer"` messages merge into the immediately following `"user"` message or flush as a `"user"` message prior to an `"assistant"` turn so history is never reordered.
  - *Why*: CodeCraft rejects `"system"` and `"developer"` roles; merging instructions into the user turn preserves full instruction fidelity and turn ordering while complying with the upstream role constraint.
  - *Alternatives Considered*: Dropping system prompts (breaks agent behavior) or emitting a separate `"system"` role (triggers the 400 error).
- **Decision 2 — Normalizing Tool Results to Labelled User Messages While Preserving Assistant `tool_calls`**:
  - *Chosen Approach*: Keep assistant `tool_calls` (including when `content` is `null`) and track pending tool call IDs and tool names across the turn. Convert matched `tool_result` blocks and historical `role: "tool"` / `role: "function"` messages into `[Tool result: <name>, call_id=<id>]\n<result>` with `role: "user"`, and label unmatched IDs with `[Tool result (unmatched): call_id=<id>]`.
  - *Why*: Eliminates upstream `role: "tool"` and `role: "function"` rejections while preserving the exact pairing between assistant tool invocations and their outputs.
  - *Alternatives Considered*: Converting assistant messages to user messages (violates assistant role preservation) or stripping `tool_calls` from assistant history (loses structured tool invocation context).

---

### 4. Technical Architecture & Data Strategy *(Technical Reference)*

- **Architecture & Component Diagram**:

```text
┌──────────────────────────────────────────────────────────────────────────┐
│                          Mobile Harness Client                           │
└────────────────────────────────────┬─────────────────────────────────────┘
                                     │ POST /v1/messages (Anthropic JSON)
                                     ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                     Cloudflare Worker Edge Router                        │
│  ┌──────────────────────┐  ┌───────────────────────┐  ┌───────────────┐  │
│  │ Proxy Token Auth     │─▶│ Request Size & JSON   │─▶│ Model Mapper  │  │
│  │ (Constant-Time Cmp)  │  │ Validation            │  │ & Token Est.  │  │
│  └──────────────────────┘  └───────────────────────┘  └───────┬───────┘  │
│                                                               │          │
│                                                               ▼          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │               CodeCraft Role-Normalization Pipeline                │  │
│  │  • Top-level system + in-history system/developer ──▶ [System]     │  │
│  │  • Assistant text / null content + tool_calls     ──▶ assistant    │  │
│  │  • Matched/unmatched tool_result & tool/function  ──▶ user         │  │
│  │  • Multimodal base64/URL images + text            ──▶ user parts   │  │
│  │  • Final Role Gate: assert every msg.role ∈ {user, assistant}      │  │
│  └────────────────────────────────────┬───────────────────────────────┘  │
└───────────────────────────────────────┼──────────────────────────────────┘
                                        │ POST /v1/chat/completions
                                        ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                CodeCraft Upstream (https://codecraftapi.com/v1)          │
└───────────────────────────────────────┬──────────────────────────────────┘
                                        │ OpenAI JSON or SSE Stream
                                        ▼
┌──────────────────────────────────────────────────────────────────────────┐
│             Anthropic Response & SSE Stream Translator                   │
│  • Non-stream JSON ──▶ Anthropic message + tool_use + usage              │
│  • SSE Stream      ──▶ Incremental text_delta + buffered tool_use blocks │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Data Model & State**:
  - `pendingSystemParts`: Ordered list of deduplicated system and developer instruction strings awaiting attachment to the next `"user"` message (or flushed as a standalone `"user"` message if followed by an `"assistant"` turn or end-of-input).
  - `pendingToolCalls`: `Map<callId, toolName>` populated from the immediately preceding `"assistant"` message's `tool_use` blocks or `tool_calls` array, used to resolve tool names and distinguish matched vs. unmatched tool results.
- **Interactive Component & State Mapping**:
  - **Input Role Validation**: Accepts `"user"`, `"assistant"`, `"system"`, `"developer"`, `"tool"`, and `"function"` for normalization; rejects any other role with a `TypeError` naming only the sanitized role identifier.
  - **Content Block Validation**: Validates `text`, `image` (`base64` and `url`), `tool_use`, `tool_result`, and `thinking` / `redacted_thinking` blocks; throws a descriptive `TypeError` on malformed or unsupported blocks rather than silently corrupting or dropping data.
  - **Final Outbound Role Gate**: Verifies `payload.messages` is non-empty and every entry has `role === "user"` or `role === "assistant"` before returning the payload to the Worker fetch handler.
- **Key Sequences & Integrations**:
  - Upstream endpoint remains fixed at `https://codecraftapi.com/v1` with HTTPS and credential-free URL validation.
  - Unit and Worker integration tests mock `fetch()` to inspect the exact serialized request body and verify all 17 required regression scenarios without consuming live inference credits.
