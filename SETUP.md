# LINE Bot Setup

Set up the optional LINE Messaging API bot after the root `private-ai-stack` and its required services are
running. Skip this guide if you do not need LINE messaging.

## Prerequisites

- Create an [ngrok account](https://ngrok.com/) and enter its authtoken as `NGROK_AUTHTOKEN` in
  `services/line/env/.env.ngrok`.
- Create a provider and channel in the [LINE Developers Console](https://developers.line.biz/console/) and
  enable the Messaging API. Keep the channel secret and a channel access token; never paste either value into chat.
- Generate an Open WebUI API key for the user account that will own the bot, and identify the Open WebUI model ID
  the bot should use.
- Import the LINE MCP registration from `openwebui/mcp/` after replacing the sample host as described in
  [MCP setup](../../doc/mcp-open-webui-setup.md).

## Configure the bot

1. Start the LINE sub-project after the root stack and its required services are running:

   ```sh
   ./start.sh prod line
   ```

2. Check that the `line` container is healthy and the ngrok tunnel is running:

   ```sh
   docker compose --env-file .env -f services/line/docker-compose.yml ps
   docker compose --env-file .env -f services/line/docker-compose.yml logs ngrok
   ```

   Use the HTTPS public URL printed by ngrok. You can also ask the assistant to call `line_check_tunnel`.

3. Open the LINE Developers Console and open **Messaging API** settings for the channel. Set the webhook URL to:

   ```text
   https://<ngrok-public-host>/api/line/webhook
   ```

   Enable **Use webhook**, then click **Verify**. The verification request should succeed.

4. In Open WebUI, ask the assistant to call `line_set_credentials`. Complete the secure form with:

   - LINE channel secret
   - LINE channel access token
   - Open WebUI model ID
   - Open WebUI API key

   The first Keycloak user to complete this form becomes the bot owner. Only that user can change the stored
   settings. The values are encrypted in the pgvector database and are not shown back to the model.

5. Call `line_check_config` and confirm that no required credential is missing. Then call
   `line_check_api` with `send_webhook_test: true` to check the LINE API and the webhook endpoint recorded by LINE.

6. Optional: call `line_set_user_profile` to set reply-template values such as timezone, language, location, and
   bio. This is also owner-only; omitted fields keep their existing values.

7. Add the bot as a friend and send a short text message. The LINE service should forward it to Open WebUI and
   reply using the configured model. Send a short voice message as a separate Whisper check if audio support is
   required.

## Troubleshooting

- `line_set_credentials` is missing values: call it again and complete every required field.
- `line_check_tunnel` has no public URL: confirm `NGROK_AUTHTOKEN` is present, then restart the LINE service.
- LINE webhook verification fails: confirm the URL includes `/api/line/webhook` and the ngrok tunnel is current.
- Bot setup tools are rejected: sign in to Open WebUI as the bot owner and retry.
- LINE verifies the webhook but replies do not arrive: run `line_check_api` and inspect the LINE service logs:

  ```sh
  docker compose --env-file .env -f services/line/docker-compose.yml logs --tail=100 line
  ```
