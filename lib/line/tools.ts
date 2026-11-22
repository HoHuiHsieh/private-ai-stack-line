import { readFile } from "node:fs/promises";

/**
 * Open WebUI tools the LINE bot may call. The list lives in openwebui/line-bot-tools.json
 * (a JSON array of connection ids such as "server:mcp:docling"). It is mounted read-only at
 * TOOLS_FILE by docker-compose.yml, and read on each request, so edits apply without a restart.
 *
 * The `line` connection is always excluded: a LINE message must not be able to change the
 * bot's credentials, profile, or tools.
 */
export const TOOLS_FILE = "/app/config/line-bot-tools.json";

const TOOL_ID = /^server:mcp:[A-Za-z0-9_.-]{1,64}$/;
const EXCLUDED = new Set(["server:mcp:line"]);

/** Tool ids to offer on this request. Returns [] (tools off) if the file is missing or invalid. */
export async function loadBotToolIds(): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(TOOLS_FILE, "utf8");
  } catch {
    console.warn(`LINE: tool list not readable at ${TOOLS_FILE}; tools are off`);
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("LINE: tool list is not valid JSON; tools are off");
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn("LINE: tool list must be a JSON array; tools are off");
    return [];
  }

  const ids = parsed.filter(
    (id): id is string => typeof id === "string" && TOOL_ID.test(id) && !EXCLUDED.has(id),
  );
  return [...new Set(ids)];
}
