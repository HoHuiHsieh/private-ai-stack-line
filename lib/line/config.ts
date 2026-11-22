import { getSecret, PUBLIC_OWNER } from "../secrets/store";

/**
 * LINE bridge settings. Everything secret, including which account owns the bot, lives in the
 * secrets table. Nothing here is read from env files except the Open WebUI URL and tuning values.
 *
 * Owner: the Keycloak `sub` of the account that first completed line_set_credentials. It is
 * stored as a public secret (service "line", name "owner_sub"), so the webhook can find the
 * owner's credentials without a user token. Only that account may change the credentials.
 *
 * Stored secrets (service "line", owned by the owner account; set with line_set_credentials):
 *   channel_secret, channel_access_token, open_webui_model, open_webui_api_key
 *
 * Env (names only, set in env/.env.agent-service):
 *   OPEN_WEBUI_URL             internal base URL, e.g. http://open-webui:3000. Not a secret.
 *   LINE_MAX_HISTORY_MESSAGES  optional, messages of per-user history sent to the model (default 20, 0 = none)
 *   NGROK_API_URL              optional, ngrok agent API for the tunnel check (default http://ngrok:4040)
 */

export const LINE_API_BASE = "https://api.line.me";
export const LINE_TEXT_LIMIT = 5000;
export const LINE_MAX_MESSAGES_PER_REPLY = 5;
// Largest media the bridge will download and forward. Images follow LINE's own 10 MB limit.
// Audio uses a lower cap, because base64 inflates it by about a third in the model request.
export const LINE_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const LINE_MAX_AUDIO_BYTES = 20 * 1024 * 1024;
export const LINE_SERVICE = "line";
export const LINE_OWNER_NAME = "owner_sub";
const DEFAULT_HISTORY = 20;

/** Logical key -> secret name in the store. */
export const LINE_SECRETS = {
  channelSecret: "channel_secret",
  channelAccessToken: "channel_access_token",
  openWebUiModel: "open_webui_model",
  openWebUiApiKey: "open_webui_api_key",
} as const;

export type LineSecretKey = keyof typeof LINE_SECRETS;
export type StoredLine = Record<LineSecretKey, string | null>;

export type LineState = { owner: string | null; stored: StoredLine };

export type LineConfig = {
  owner: string;
  channelSecret: string;
  channelAccessToken: string;
  model: string;
  openWebUiUrl: string;
  openWebUiApiKey: string;
  maxHistoryMessages: number;
};

export class LineConfigError extends Error {}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/** The owner's `sub`, or null if no owner has been recorded yet. */
export function getLineOwnerSub(): Promise<string | null> {
  return getSecret(PUBLIC_OWNER, LINE_SERVICE, LINE_OWNER_NAME);
}

/** Owner and all stored LINE secrets. Stored values are null when there is no owner. Never log them. */
export async function readLineState(): Promise<LineState> {
  const owner = await getLineOwnerSub();
  const keys = Object.keys(LINE_SECRETS) as LineSecretKey[];
  if (!owner) {
    return { owner: null, stored: Object.fromEntries(keys.map((k) => [k, null])) as StoredLine };
  }
  const values = await Promise.all(keys.map((k) => getSecret(owner, LINE_SERVICE, LINE_SECRETS[k])));
  return { owner, stored: Object.fromEntries(keys.map((k, i) => [k, values[i]])) as StoredLine };
}

export function getOpenWebUIUrl(): string | undefined {
  return env("OPEN_WEBUI_URL")?.replace(/\/$/, "");
}

/**
 * Open WebUI connection for server-side writes (MCP chat events, scheduled reminders). The API key
 * is the LINE credential `open_webui_api_key`, set through line_set_credentials. It is never read from env.
 * Returns null until both the URL and the key are configured.
 */
export async function getOpenWebUIConnection(): Promise<{ baseUrl: string; apiKey: string } | null> {
  const baseUrl = getOpenWebUIUrl();
  if (!baseUrl) return null;
  const { stored } = await readLineState();
  if (!stored.openWebUiApiKey) return null;
  return { baseUrl, apiKey: stored.openWebUiApiKey };
}

/** Full bridge configuration, or LineConfigError naming what is missing. */
export async function getLineConfig(): Promise<LineConfig> {
  const { owner, stored } = await readLineState();
  const openWebUiUrl = getOpenWebUIUrl();

  const missing: string[] = [];
  if (!owner) missing.push("bot owner (run line_set_credentials)");
  if (!stored.channelSecret) missing.push(`stored ${LINE_SECRETS.channelSecret}`);
  if (!stored.channelAccessToken) missing.push(`stored ${LINE_SECRETS.channelAccessToken}`);
  if (!stored.openWebUiModel) missing.push(`stored ${LINE_SECRETS.openWebUiModel}`);
  if (!stored.openWebUiApiKey) missing.push(`stored ${LINE_SECRETS.openWebUiApiKey}`);
  if (!openWebUiUrl) missing.push("OPEN_WEBUI_URL");
  if (missing.length) {
    throw new LineConfigError(`LINE is not configured. Missing: ${missing.join(", ")}.`);
  }

  const rawHistory = env("LINE_MAX_HISTORY_MESSAGES");
  const history = rawHistory === undefined ? DEFAULT_HISTORY : Number(rawHistory);
  return {
    owner: owner!,
    channelSecret: stored.channelSecret!,
    channelAccessToken: stored.channelAccessToken!,
    model: stored.openWebUiModel!,
    openWebUiUrl: openWebUiUrl!,
    openWebUiApiKey: stored.openWebUiApiKey!,
    maxHistoryMessages: Number.isInteger(history) && history >= 0 ? history : DEFAULT_HISTORY,
  };
}

export function getNgrokApiUrl(): string {
  return (env("NGROK_API_URL") ?? "http://ngrok:4040").replace(/\/$/, "");
}
