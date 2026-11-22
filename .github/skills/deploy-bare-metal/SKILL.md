---
name: deploy-bare-metal
description: Configure the line service's env files (env/.env.line, env/.env.ngrok) and bring the line stack (LINE bot bridge, LINE MCP, internal API, and the ngrok webhook tunnel) up on a bare-metal host, from preflight checks through live verification. Use when asked to set up, fill in, check, deploy, or start the line service on a new or existing server.
---

# Deploy the line service on bare metal

Goal: `line` and `ngrok` are running. `env/.env.line` is complete, and `INTERNAL_API_TOKEN` matches every
service that uses it. `/healthz` returns `ok`, `/api/mcp/line` returns 401 with no token, and `/internal/`
returns 401 with no token.

This skill covers the line service only. The root stack (Keycloak, nginx, certs, agent-service, pgvector) and
the Open WebUI and Whisper services must be up. For the whole host, use the root skill
`.claude/skills/deploy-bare-metal/SKILL.md` and `doc/QUICKSTART.md`.

LINE credentials are not env values. They are stored through the `line_set_credentials` MCP form (see
`services/line/README.md`). This skill configures only the env files and the containers.

## Ground rules

- **Do not read secrets.** Never open `env/.env.line`, `env/.env.ngrok`, `.env`, or any other `env/.env.*` file
  except the `*.example` templates and `env/.env.dev`. Never print a secret value. Copy values by name, and show
  only names, `match`/`mismatch`, or HTTP codes.
- **`INTERNAL_API_TOKEN` is a shared secret with an owner.** The line service verifies it. The docling-mcp
  service sends it. Generate it only once, in `services/line/env/.env.line`. Copy the same value to every other
  file. Do not regenerate it on an existing install, because every copy then breaks. Ask the user before you
  change it.
- **Do not overwrite a filled file.** Create a file from its template only when it is missing. For an existing
  file, edit only keys that step 5 reports as empty or wrong.
- **Do not change the stack's shape.** No `ports:` entries, no new services, no literal values in compose files.
  Config goes in env files. The `ngrok` service stays outbound-only.
- **Keep webhook secrets out of chat.** `NGROK_AUTHTOKEN` is entered by the user in `env/.env.ngrok`.
- **Report faithfully.** Show the check output. Do not say the bot works until the live checks in step 6 pass.

## Step 0: Preflight (read-only)

Run from the repo root. Stop at the first failure.

```sh
docker compose version
docker network ls --format '{{.Name}}' | grep -x private-ai-stack_backend || echo "FAIL: start the root stack first"
test -s certs/ca-bundle.crt && echo "ca-bundle ok" || echo "FAIL: ca-bundle missing"
test -s env/.env.agent-service && echo "agent-service env present" || echo "FAIL: agent-service env missing"
test -s .env && echo ".env present" || echo "FAIL: .env missing"
test -s openwebui/line-bot-tools.json && test -s openwebui/line-bot-features.json && echo "openwebui line-bot json ok" || echo "FAIL: openwebui line-bot json missing"
test -s services/line/ngrok.yml && echo "ngrok.yml ok" || echo "FAIL: services/line/ngrok.yml missing"
docker ps --format '{{.Names}}\t{{.Status}}' | grep -E 'open-webui|whisper|agent-service' || echo "WARN: open-webui, whisper or agent-service not running"
docker ps -a --format '{{.Names}}\t{{.Status}}' | grep -i 'line' || echo "line not created yet (fresh install)"
```

- `services/line/ngrok.yml` is required by the `ngrok` service. It is currently **untracked** in git, and the
  compose change that mounts it is **uncommitted**. Tell the user to commit both. Do not commit for them.
- Whisper is needed only for voice messages (`models.json` points at `http://whisper:8000/v1`). A missing Whisper
  is a warning, not a failure, for the text bot.

## Step 1: Inventory (names only)

From `services/line/`:

```sh
ls -la env/
git status --short
```

| Template | Filled file |
| --- | --- |
| `env/.env.line.example` | `env/.env.line` |
| `env/.env.ngrok.example` | `env/.env.ngrok` (optional) |

`ls -l` hides dotfiles, so use `ls -la`. Report which filled files exist. Do not print their content.

## Step 2: Create missing files

Create only a file that is missing. Never copy onto an existing file:

```sh
[ -e env/.env.line ]  || cp env/.env.line.example env/.env.line
[ -e env/.env.ngrok ] || cp env/.env.ngrok.example env/.env.ngrok
chmod 600 env/.env.line env/.env.ngrok
```

`env/.env.ngrok` is optional. The stack starts without it, and the webhook tunnel does not work without it.

## Step 3: Fill the values

Put these helpers in the shell first. They print nothing:

```sh
# set_val <file> <KEY> <value>: writes the value and prints nothing.
set_val() { sed -i "s|^$2=.*|$2=$3|" "$1"; }

# copy_val <src-file> <SRC_KEY> <dst-file> <DST_KEY>: copies one value by name, prints nothing.
# Refuses a missing file, an empty source, or a value with & or |.
copy_val() {
  [ -f "$1" ] || { echo "FAIL: source file $1 not found"; return 1; }
  v=$(grep -h "^$2=" "$1" | head -1 | cut -d= -f2-)
  [ -n "$v" ] || { echo "FAIL: $2 is empty or missing in $1"; return 1; }
  case "$v" in *'&'*|*'|'*) echo "FAIL: $2 has & or |"; return 1;; esac
  set_val "$3" "$4" "$v"
}
```

Paths are relative to `services/line/`. The root files are `../../.env` and `../../env/`.

### Shared with agent-service (copy by name)

```sh
copy_val ../../env/.env.agent-service AGENT_DATABASE_URL       env/.env.line AGENT_DATABASE_URL
copy_val ../../env/.env.agent-service SECRETS_ENCRYPTION_KEY   env/.env.line SECRETS_ENCRYPTION_KEY
copy_val ../../env/.env.agent-service MCP_JWKS_URL             env/.env.line MCP_JWKS_URL
copy_val ../../env/.env.agent-service MCP_JWT_ISSUER           env/.env.line MCP_JWT_ISSUER
copy_val ../../env/.env.agent-service OIDC_ISSUER              env/.env.line OIDC_ISSUER
copy_val ../../.env                   APP_PUBLIC_URL           env/.env.line APP_PUBLIC_URL
```

`MCP_JWT_AUDIENCE` is not copied. QUICKSTART says it may stay empty, and agent-service does not set it either.

### Fixed values (write as-is)

| Key | Value | Source |
| --- | --- | --- |
| `PG_POOL_MAX` | `10` | code default, `lib/db/pool.ts` |
| `LINE_MAX_HISTORY_MESSAGES` | `20` | code default, `lib/line/config.ts` (0 = no history) |
| `OPEN_WEBUI_URL` | `http://open-webui:3000` | the example |
| `NGROK_API_URL` | `http://ngrok:4040` | the example and code default |

```sh
set_val env/.env.line PG_POOL_MAX 10
set_val env/.env.line LINE_MAX_HISTORY_MESSAGES 20
```

Re-check the defaults in the code before you write them, because they may have changed.

### `INTERNAL_API_TOKEN` (generate once, copy everywhere else)

Generate only if the key is empty in `env/.env.line`:

```sh
if grep -qE '^INTERNAL_API_TOKEN=$' env/.env.line; then
  set_val env/.env.line INTERNAL_API_TOKEN "$(openssl rand -hex 32)"
  echo "generated INTERNAL_API_TOKEN"
fi
```

Then copy the same value to every consumer. Right now the only consumer is docling-mcp:

```sh
copy_val env/.env.line INTERNAL_API_TOKEN ../docling/env/.env.docling-mcp INTERNAL_API_TOKEN
```

If the token already exists in both files and matches, do not regenerate it. If the two differ, stop and ask the
user which value is current. Do not overwrite either file without approval.

### Notes on keys that are not used

`WHISPER_URL` and `WHISPER_MODEL` are present in `env/.env.line`, but no code reads them. Whisper is configured
through `models.json`. Leave them alone unless the user asks to remove them, and say so in the report.

## Step 4: Verify the files by name and shape

1. **Empty values.** Print names only:

   ```sh
   grep -HE '^[A-Z_0-9]+=$' env/.env.line env/.env.ngrok
   ```

   Allowed empty keys: `MCP_JWT_AUDIENCE`, and `NGROK_AUTHTOKEN` in `env/.env.ngrok` (optional). Anything else is a
   failure to fix. `LINE_MAX_HISTORY_MESSAGES` may be `0`, but it must not be empty.

2. **Shared-value matches.** Print `match` or `mismatch` only:

   ```sh
   chk() {
     a=$(grep -h "^$1=" "$2" | cut -d= -f2-); b=$(grep -h "^$3=" "$4" | cut -d= -f2-)
     [ -n "$a" ] && [ "$a" = "$b" ] && echo "$1 vs $3: match" || echo "$1 vs $3: mismatch"
     unset a b
   }
   chk AGENT_DATABASE_URL          env/.env.line  AGENT_DATABASE_URL          ../../env/.env.agent-service
   chk SECRETS_ENCRYPTION_KEY      env/.env.line  SECRETS_ENCRYPTION_KEY      ../../env/.env.agent-service
   chk OIDC_ISSUER                 env/.env.line  OIDC_ISSUER                 ../../env/.env.agent-service
   chk INTERNAL_API_TOKEN          env/.env.line  INTERNAL_API_TOKEN          ../docling/env/.env.docling-mcp
   ```

   `INTERNAL_API_TOKEN` matches only if the docling-mcp file has the copy from step 3.

3. **Compose reads the files.** Run from `services/line/`. Do not paste the output, because it shows secrets:

   ```sh
   docker compose -f docker-compose.yml config --quiet && echo "compose config ok"
   ```

4. **No published ports:**

   ```sh
   grep -n 'ports:' docker-compose.yml docker-compose.dev.yml && echo "FAIL: ports found" || echo "no ports"
   ```

## Step 5: Start the stack

From the repo root:

```sh
./start.sh prod line          # or: ./start.sh dev line (hot reload)
docker compose --env-file .env -f services/line/docker-compose.yml ps --format '{{.Service}}\t{{.State}}\t{{.Health}}'
```

The first start builds the `line` image. `ngrok` starts even without an authtoken, and that is expected. Its tunnel
does not come up without one.

**ngrok config must use `agent.web_addr`.** The ngrok v3 config rejects a top-level `web_addr` key
(`field web_addr not found in type config.v3yamlConfig`), and the container then restarts in a loop. The agent API
address is set under `agent:`. `services/line/ngrok.yml` must read:

```yaml
version: "3"
agent:
  web_addr: 0.0.0.0:4040
```

Check the file offline before you restart anything. This runs no tunnel and needs no token:

```sh
docker run --rm -v "$PWD/services/line/ngrok.yml:/etc/ngrok.yml:ro" --entrypoint ngrok ngrok/ngrok:3 config check --config /etc/ngrok.yml
```

Expect `Valid configuration file`. After a restart, confirm the loop is gone: `RestartCount` stays at 0, the log has no
`ERROR`, and the agent API answers from the line container:

```sh
docker exec <line-container> wget -qO- http://ngrok:4040/api/tunnels | head -c 200
```

Do not change the compose `command:` without approval. It is already uncommitted.

If the line service fails, read its logs:

```sh
docker compose -f services/line/docker-compose.yml logs --tail=100 line
```

Fix the cause in the env file, then run `./start.sh prod line` again.

If the docling-mcp token was copied in step 3, restart docling-mcp so it picks up the new value:

```sh
./start.sh prod docling
```

## Step 6: Verify live

1. **Container health.** `line` must be `healthy`. `ngrok` must be `running`:

   ```sh
   docker compose --env-file .env -f services/line/docker-compose.yml exec line wget -qO- http://127.0.0.1:3000/healthz; echo
   ```

   Expect `ok`.

2. **MCP auth through nginx.** Read the hostname into a shell variable, never print `.env`:

   ```sh
   APP_HOST=$(grep -h '^APP_HOST=' .env | cut -d= -f2-)
   curl -sk -o /dev/null -w 'line mcp POST (no token): %{http_code}\n' -X POST \
     -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' "https://$APP_HOST/api/mcp/line"
   unset APP_HOST
   ```

   - `401`: auth is configured.
   - `500` with "not configured": `MCP_JWT_ISSUER` or `MCP_JWKS_URL` is empty. Go back to step 3.

3. **Internal API fails closed.** Two calls from inside the backend network. Neither should pass:

   ```sh
   docker compose --env-file .env -f services/line/docker-compose.yml exec line wget -qO- --post-data='{}' \
     --header='Content-Type: application/json' http://127.0.0.1:3000/internal/chat-event 2>&1 | tail -1
   ```

   Expect a `401` error from wget with `unauthorized`. Then check that the token passes:

   ```sh
   docker compose --env-file .env -f services/line/docker-compose.yml exec line sh -c \
     'wget -qO- --post-data="{}" --header="Content-Type: application/json" --header="x-internal-token: $INTERNAL_API_TOKEN" http://127.0.0.1:3000/internal/chat-event 2>&1 | tail -1'
   ```

   With the token, an empty body should return `400 Invalid`, `404`, or `502`. It must not return `401`. Report the
   actual response. The `$INTERNAL_API_TOKEN` expansion happens inside the container, so the value is never printed.

4. **Tunnel.** Ask the user to run `line_check_tunnel` from their MCP client. It shows the ngrok public URL and whether
   Open WebUI is reachable. Only the bot owner can run the settings tools.

5. **Bot setup (handoff).** The user calls `line_set_credentials` from the MCP client to store the channel secret,
   access token, Open WebUI model and API key. The first account to complete it becomes the owner. Then the user
   runs `line_check_config` until nothing is missing, and `line_check_api` with `send_webhook_test: true`.

## Step 7: Operations

- **Restart policy.** Both containers use `restart: unless-stopped`.
- **Data.** The line service holds no volume. Its state (credentials and chat mappings) is encrypted in the
  `service_secrets` table of the pgvector database. Back up that database. Losing `SECRETS_ENCRYPTION_KEY` makes
  those secrets unreadable.
- **Token rotation.** Changing `INTERNAL_API_TOKEN` requires updating every copy at once, then restarting every
  consumer. Do it only with the user's approval.

## Done when

- `env/.env.line` exists with `chmod 600`. Its only empty key is `MCP_JWT_AUDIENCE`.
- Every shared-value check prints `match`, and the compose config check passes.
- `line` is `healthy`, `ngrok` is running, and `/healthz` returns `ok`.
- `/api/mcp/line` with no token returns 401, and the internal API rejects a call with no token.
- The user knows the remaining manual steps: `line_set_credentials`, `line_check_config`, `line_check_api`, and
  the tunnel check.

End with a short report: which files were created or edited, which values the user still has to set, the
actual codes and `match` results from steps 4 and 6, and the uncommitted files (`ngrok.yml`, the compose change).
Do not include any secret value.
