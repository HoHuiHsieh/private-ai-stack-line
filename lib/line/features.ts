import { readFile } from "node:fs/promises";

/**
 * Open WebUI chat features for LINE requests (web_search, code_interpreter, image_generation, memory).
 * The file is openwebui/line-bot-features.json, mounted read-only at FEATURES_FILE by docker-compose.yml
 * and read on each request, so edits apply without a restart. A missing or invalid file turns all features off.
 */
export const FEATURES_FILE = "/app/config/line-bot-features.json";

const KNOWN_FEATURES = new Set(["web_search", "code_interpreter", "image_generation", "memory"]);

/** Features to enable on this request, e.g. { web_search: true }. Unknown keys and non-boolean values are dropped. */
export async function loadBotFeatures(): Promise<Record<string, boolean>> {
  let raw: string;
  try {
    raw = await readFile(FEATURES_FILE, "utf8");
  } catch {
    console.warn(`LINE: feature list not readable at ${FEATURES_FILE}; features are off`);
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("LINE: feature list is not valid JSON; features are off");
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.warn("LINE: feature list must be a JSON object; features are off");
    return {};
  }

  const features: Record<string, boolean> = {};
  for (const [name, on] of Object.entries(parsed)) {
    if (KNOWN_FEATURES.has(name) && typeof on === "boolean") features[name] = on;
  }
  return features;
}
