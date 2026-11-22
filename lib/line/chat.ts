/**
 * Sends a conversation to Open WebUI's OpenAI-compatible endpoint and returns the
 * assistant's text. Non-streaming: LINE needs the complete answer in one reply.
 *   variables  fills Open WebUI template placeholders such as {{USER_LANGUAGE}}
 *   toolIds    tools offered for this request; the model chooses which to call (native function calling)
 */

/** OpenAI-style content parts. Images go as data URLs. Audio is transcribed first (see lib/speech/whisper.ts). */
export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type ChatMessage = { role: "user" | "assistant"; content: string | ContentPart[] };
export type OpenWebUIConnection = { baseUrl: string; apiKey: string };
export type ChatOptions = {
  variables?: Record<string, string>;
  toolIds?: string[];
  features?: Record<string, boolean>;
};

// Legacy tool mode runs several tool calls before the model answers, which can take minutes.
const TIMEOUT_MS = 300_000;

/** Features that are switched on for this request. */
function enabledFeatures(options: ChatOptions): Record<string, boolean> {
  return Object.fromEntries(Object.entries(options.features ?? {}).filter(([, on]) => on));
}

function needsLegacyMode(options: ChatOptions): boolean {
  // Open WebUI runs the built-in web search and code interpreter only in legacy mode.
  const legacyFeature = ["web_search", "code_interpreter"].some((f) => enabledFeatures(options)[f]);
  return (options.toolIds?.length ?? 0) > 0 || legacyFeature;
}

export async function askOpenWebUI(
  conn: OpenWebUIConnection,
  model: string,
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<string> {
  const body = {
    model,
    messages,
    stream: false,
    ...(options.variables ? { variables: options.variables } : {}),
    // Legacy mode runs the tools once and returns a normal completion. Native mode needs streaming
    // and a chat id, so without them the caller would receive unexecuted tool_calls and no text.
    ...(options.toolIds && options.toolIds.length > 0 ? { tool_ids: options.toolIds } : {}),
    ...(Object.keys(enabledFeatures(options)).length > 0 ? { features: enabledFeatures(options) } : {}),
    ...(needsLegacyMode(options) ? { params: { function_calling: "legacy" } } : {}),
  };
  const res = await fetch(`${conn.baseUrl}/api/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${conn.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Open WebUI chat request failed: HTTP ${res.status}`);

  const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("Open WebUI returned no message content");
  }
  return content;
}
