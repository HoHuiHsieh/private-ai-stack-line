# LINE service

This is the standalone LINE Compose repository inside `private-ai-stack/services/line`.

- The deployment skill is `.github/skills/deploy-bare-metal/SKILL.md`.
- Never read or print secrets from `env/.env.line`, `env/.env.ngrok`, or other filled env files. Read only `*.example` templates and `env/.env.dev`.
- `INTERNAL_API_TOKEN` is shared with every service that calls the LINE internal API. Generate it once and copy it only by name; changing it requires updating all consumers and approval.
- Keep webhook credentials and `NGROK_AUTHTOKEN` out of chat. LINE credentials are configured through the LINE MCP forms.
- Do not add `ports:` or services. The ngrok service is outbound-only.
- The service joins the root `private-ai-stack_backend` network and stores credentials in pgvector through the shared encryption key.
- Use container commands for npm and validation; do not run npm on the host.