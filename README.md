# Mobile Harness — CodeCraft OpenAI-to-Anthropic Proxy

A self-hosted Cloudflare Worker that accepts Anthropic Messages API requests from Mobile Harness / Claude Code and translates them to an OpenAI-compatible Chat Completions endpoint. The upstream is fixed by server configuration; the client cannot choose another URL.

## Important limitations

- This is a compatibility layer, not an Anthropic service or a guarantee that every Claude Code feature works against every third-party model.
- Tool arguments are buffered per call and emitted as valid Anthropic tool blocks after the upstream stream finishes. Text is streamed as it arrives. This prioritizes a well-formed event sequence over token-by-token tool-argument display.
- The API provider must support Chat Completions, SSE streaming, function/tool calls and any requested image inputs. Check `GET /v1/models` and model capabilities in your provider dashboard.
- Cloudflare hosting does not make upstream inference free. Provider usage may be billed or limited.
- Free-tier quotas and service terms can change; lifetime zero-cost or zero-downtime cannot be guaranteed.

## Default architecture

Mobile Harness → `POST /v1/messages` (Anthropic) → Worker → CodeCraft `POST /v1/chat/completions` → Worker → Anthropic JSON/SSE.

## Configured upstream

`UPSTREAM_BASE_URL=https://codecraftapi.com/v1`

Do not put API credentials in source code or `wrangler.jsonc`. Add these as Cloudflare Worker **Secrets**:

- `PROXY_TOKEN`: random, unique client token for Mobile Harness.
- `UPSTREAM_API_KEY`: newly issued CodeCraft API key.

The key previously exposed in chat should be revoked and replaced before deployment.

## Mobile Harness settings

After tests pass and the Worker is deployed:

- Provider: Custom API
- Base URL: the bare `https://<your-worker>.<your-subdomain>.workers.dev` URL; no trailing slash and no `/v1`
- API Key: the `PROXY_TOKEN` secret's value
- Model: an exact ID available to your CodeCraft account, such as `claude-opus-5.5` or `claude-fable-5.1` only if listed by `/v1/models`

Mobile Harness appends `/v1/messages` to the bare Worker URL for Anthropic protocol calls.

## Endpoints

- `GET /health`: reports whether required config is present; it does not ping CodeCraft.
- `GET /v1/models`: authenticated proxy pass-through to upstream `/models`.
- `POST /v1/messages/count_tokens`: authenticated rough local estimate, not a provider tokenizer.
- `POST /v1/messages`: authenticated Anthropic Messages API compatibility route.

## Run tests

Use Node.js 24 or another currently supported Node.js version, and npm.

```sh
npm install
npm test
```

Tests mock upstream calls; they do not consume CodeCraft inference credits.

## Deploy with Wrangler (optional command-line path)

```sh
npm install
npx wrangler login
npx wrangler secret put PROXY_TOKEN
npx wrangler secret put UPSTREAM_API_KEY
npm test
npm run deploy
```

Do not put secret values directly in shell command text or commit them. The interactive `secret put` prompt asks for the value.

## Browser-only deployment

1. Create a new public or private GitHub repository and upload this project, preserving `.github/workflows/test.yml` and all paths.
2. In Cloudflare Dashboard, open Workers & Pages → Create application → Import a repository.
3. Connect GitHub and choose the new repository and production branch `main`.
4. Set build command to `npm test`; set deploy command to `npx wrangler deploy` (or `npm run deploy`). Use the repository root as the root directory.
5. Save and deploy. The `wrangler.jsonc` file names the Worker and enables the `workers.dev` hostname.
6. In Worker → Settings → Variables & Secrets, add `PROXY_TOKEN` and `UPSTREAM_API_KEY` as **Secrets**, not plaintext vars, then deploy the new version.
7. Run all HTTP tests below before configuring Mobile Harness.

Cloudflare Workers Builds can redeploy from Git commits. It does not mean your Worker needs an always-running process on your phone.

## cURL smoke tests

Replace `YOUR-WORKER-URL` with the exact Cloudflare URL. The `read -s` prompt prevents the token being echoed on screen.

Health (public; config presence only):

```sh
curl -i 'https://YOUR-WORKER-URL/health'
```

Model catalogue (auth required):

```sh
read -rsp 'Proxy token: ' PROXY_TOKEN; printf '\n'
curl -sS 'https://YOUR-WORKER-URL/v1/models' -H "x-api-key: ${PROXY_TOKEN}"
unset PROXY_TOKEN
```

Non-stream response:

```sh
read -rsp 'Proxy token: ' PROXY_TOKEN; printf '\n'
curl -sS -i 'https://YOUR-WORKER-URL/v1/messages' \
  -H "x-api-key: ${PROXY_TOKEN}" \
  -H 'anthropic-version: 2023-06-01' \
  -H 'content-type: application/json' \
  --data-raw '{"model":"claude-opus-5.5","max_tokens":80,"stream":false,"messages":[{"role":"user","content":"Reply exactly PROXY_NONSTREAM_OK"}]}'
unset PROXY_TOKEN
```

Streaming response:

```sh
read -rsp 'Proxy token: ' PROXY_TOKEN; printf '\n'
curl -N -sS 'https://YOUR-WORKER-URL/v1/messages' \
  -H "x-api-key: ${PROXY_TOKEN}" \
  -H 'anthropic-version: 2023-06-01' \
  -H 'content-type: application/json' \
  --data-raw '{"model":"claude-opus-5.5","max_tokens":80,"stream":true,"messages":[{"role":"user","content":"Count from one to five."}]}'
unset PROXY_TOKEN
```

Check that streaming contains `message_start`, the content block events, `message_delta`, and `message_stop`.

Tool test:

```sh
read -rsp 'Proxy token: ' PROXY_TOKEN; printf '\n'
curl -sS 'https://YOUR-WORKER-URL/v1/messages' \
  -H "x-api-key: ${PROXY_TOKEN}" \
  -H 'anthropic-version: 2023-06-01' \
  -H 'content-type: application/json' \
  --data-raw '{"model":"claude-opus-5.5","max_tokens":128,"tools":[{"name":"echo","description":"Return the supplied text.","input_schema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}],"tool_choice":{"type":"tool","name":"echo"},"messages":[{"role":"user","content":"Call echo with text proxy_tool_ok."}]}'
unset PROXY_TOKEN
```

Expected: Anthropic `tool_use` content and `stop_reason: "tool_use"`. To verify the *real agent loop*, ask Mobile Harness to create and read back a harmless file in a test project.

## Model remapping

`MODEL_MAP_JSON` defaults to `{}`. If the agent sends a model alias that CodeCraft does not recognize, set the JSON map in `wrangler.jsonc`, for example:

```json
"MODEL_MAP_JSON": "{\"some-provider-alias\":\"claude-fable-5.1\"}"
```

Only use a target ID confirmed by the authenticated `/v1/models` result. Do not map every request to a fixed model unless you intentionally want to ignore the model selected in Mobile Harness.

## Maintenance

- Code change: commit to the connected production branch; Workers Builds runs the configured build/deploy pipeline.
- Rotate upstream key: create a new CodeCraft key, replace the `UPSTREAM_API_KEY` Secret in Cloudflare, deploy, test, then revoke the old key.
- Rotate proxy token: replace `PROXY_TOKEN` Secret, deploy, then update Mobile Harness API Key to the new value.
- Logs: use Worker Observability in Cloudflare Dashboard; optional CLI: `npx wrangler tail mobile-harness-codecraft-proxy`.
- Free quota: consult the current Cloudflare plan and CodeCraft usage/billing dashboard. No lifetime pricing or uptime guarantee is implied.
