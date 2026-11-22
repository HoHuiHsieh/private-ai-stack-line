# line

LINE bot bridge. A LINE message goes to Open WebUI, which answers with the model named in the bot's settings,
and the answer goes back to LINE. This service also serves the LINE MCP (bot setup and checks) and the
ngrok tunnel that gives LINE a public webhook URL.

## Containers

| Service | Role | Ports |
|---|---|---|
| `line` | Webhook `/api/line/webhook`, MCP `/api/mcp/line`, internal chat-event relay | none (internal) |
| `ngrok` | Public HTTPS tunnel to `line:3000` for the LINE webhook | none (outbound only) |

Start: `./start.sh prod line` (or `./start.sh dev line` for hot reload). Start the root stack first.

## Configuration

- **`models.json`**: audio model for speech-to-text (Whisper). It only lists the `audio` / `standard` tier.
  The chat model is not here. It is set with the MCP (see below).
- **Env files** (`env/`, created from the `.example` files, never committed):
  - `.env.line`: `INTERNAL_API_TOKEN` (must match agent-service), database URL and key (same as agent-service),
    `MCP_JWKS_URL`, `MCP_JWT_ISSUER`, `MCP_JWT_AUDIENCE`, `OIDC_ISSUER`, `APP_PUBLIC_URL`, `OPEN_WEBUI_URL`,
    `LINE_MAX_HISTORY_MESSAGES`, `NGROK_API_URL`.
  - `.env.ngrok`: `NGROK_AUTHTOKEN` (optional; the stack starts without it).

## Secrets

Secrets are stored encrypted in the `service_secrets` table, keyed by the owner (the Keycloak `sub`) and service `line`.
They are set through MCP tools, never by editing files. Values are never shown back to the model.

| Name | Set by | Scope | Purpose |
|---|---|---|---|
| `channel_secret` | `line_set_credentials` (secure form) | owner | Verifies LINE webhook signatures |
| `channel_access_token` | `line_set_credentials` (secure form) | owner | Replies and pushes via the LINE API |
| `open_webui_model` | `line_set_credentials` (secure form) | owner | Model ID Open WebUI uses to answer, e.g. `org/model-name` |
| `open_webui_api_key` | `line_set_credentials` (secure form) | owner | Key for the Open WebUI chat API |
| `owner_sub` | Written once by the first successful `line_set_credentials` | public | Identifies the bot owner. Only the owner can change credentials |
| `user_profile` | `line_set_user_profile` | owner | Template variables (timezone, language, etc.) filled into replies |
| `chat_<conversationId>` | Bridge, automatically | owner | Maps a LINE conversation to its Open WebUI chat |

Setup order:
1. Call `line_set_credentials`. The first account to complete the form becomes the bot owner.
2. Call `line_check_config` until nothing is missing.
3. Call `line_check_api` (add `send_webhook_test: true` to test the webhook).
4. Call `line_check_tunnel` to confirm the public URL and that Open WebUI is reachable.
5. Optional: `line_set_user_profile`.

## MCP tools

Endpoint: `POST /api/mcp/line` (Keycloak bearer token). Only the bot owner can use the tools that change settings.

| Tool | Arguments | What it does |
|---|---|---|
| `line_set_credentials` | none (secure form) | Stores the four credentials above. The first account to complete it becomes the owner |
| `line_set_user_profile` | `timezone`, `language`, `gender`, `birth_date` (YYYY-MM-DD), `location`, `groups`, `bio` (all optional) | Stores the reply profile. Omitted fields keep their values. Owner only |
| `line_check_config` | none | Shows the owner and which credentials are set (presence and timestamps only). No external calls |
| `line_check_api` | `send_webhook_test` (boolean, default false) | Checks the LINE API with the stored token: bot info and the webhook endpoint on record |
| `line_check_tunnel` | none | Shows the ngrok public URLs and whether Open WebUI is reachable |

## Internal API (agent-service only)

`POST /internal/chat-event` with header `x-internal-token`. It forwards a tool's live UI event into the Open WebUI chat.
Used by the docling MCP. Not reachable from nginx.

## Verify

- `docker compose --env-file .env -f services/line/docker-compose.yml ps`
- `line_check_config` reports nothing missing; `line_check_api` returns the bot info.
- Send a text message to the bot; the answer should arrive from Open WebUI.
