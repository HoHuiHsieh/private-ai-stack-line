import type { McpContext, McpServerDef, McpTool } from "../server";
import { elicitForm } from "../ui";
import { ownerOf } from "../owner";
import { getBotInfo, getWebhookEndpoint, LineApiError, testWebhookEndpoint } from "../../line/api";
import {
  getLineConfig,
  getLineOwnerSub,
  getNgrokApiUrl,
  getOpenWebUIUrl,
  LINE_API_BASE,
  LINE_OWNER_NAME,
  LINE_SECRETS,
  LINE_SERVICE,
  LineConfigError,
  readLineState,
  type LineSecretKey,
} from "../../line/config";
import { claimPublicSecret, getSecretMeta, setSecret } from "../../secrets/store";
import { isValidValue } from "../../secrets/policy";
import { parseProfile, readUserProfile, writeUserProfile } from "../../line/profile";

/**
 * LINE Messaging API bridge, served at /api/mcp/line.
 * Credentials are entered through a secure form (line_set_credentials), encrypted and stored
 * under the owner account. The first account to complete the form becomes the owner, and only
 * that account may change the credentials. The check tools report presence and status only.
 * They never return secret values, and errors carry HTTP status, not request headers.
 */

const FORM_FIELDS: Record<LineSecretKey, { title: string; format?: "password" }> = {
  channelSecret: { title: "LINE channel secret", format: "password" },
  channelAccessToken: { title: "LINE channel access token", format: "password" },
  openWebUiModel: { title: "Open WebUI model id (e.g. org/model-name)" },
  openWebUiApiKey: { title: "Open WebUI API key", format: "password" },
};

const NOT_OWNER = "Only the LINE bot owner account can set these credentials";

const setProfileTool: McpTool = {
  name: "line_set_user_profile",
  description:
    "Set the profile used in LINE replies: timezone, language, gender, birth date, location, groups, and bio. " +
    "Fill in the fields you can determine; omitted fields keep their stored values. The values are encrypted and " +
    "filled into the Open WebUI template variables on every reply. Only the bot owner can use it, after line_set_credentials.",
  inputSchema: {
    type: "object",
    properties: {
      timezone: { type: "string", description: "IANA timezone, e.g. Asia/Taipei (default Asia/Taipei)" },
      language: { type: "string", description: "Preferred language, e.g. en-US or zh-TW" },
      gender: { type: "string", description: "Gender, up to 40 characters" },
      birth_date: { type: "string", description: "Birth date, YYYY-MM-DD" },
      location: { type: "string", description: "Location, up to 100 characters" },
      groups: { type: "string", description: "Groups, comma separated, up to 200 characters" },
      bio: { type: "string", description: "Short bio, up to 500 characters" },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx: McpContext) => {
    const sub = ownerOf(ctx);
    const owner = await getLineOwnerSub();
    if (!owner) throw new Error("Set up the LINE credentials first (line_set_credentials)");
    if (owner !== sub) throw new Error(NOT_OWNER);

    // Merge with what is stored, so a partial update keeps the other fields.
    const existing = await readUserProfile(owner);
    const current = existing
      ? {
          timezone: existing.timezone,
          language: existing.language,
          gender: existing.gender,
          birth_date: existing.birthDate,
          location: existing.location,
          groups: existing.groups,
          bio: existing.bio,
        }
      : {};
    await writeUserProfile(owner, parseProfile({ ...current, ...args }));
    return "The LINE user profile was updated.";
  },
};

const setCredentialsTool: McpTool = {
  name: "line_set_credentials",
  description:
    "Open a secure form to enter the LINE bot credentials (channel secret, channel access token) and the Open WebUI " +
    "model and API key used to answer messages. Values are encrypted and stored; they are never shown back to the model. " +
    "The first account to complete the form becomes the bot owner. Only the owner can use it afterwards.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx: McpContext) => {
    const sub = ownerOf(ctx);

    // Refuse early, before showing the form, when someone else already owns the bot.
    const existing = await getLineOwnerSub();
    if (existing && existing !== sub) throw new Error(NOT_OWNER);

    const keys = Object.keys(FORM_FIELDS) as LineSecretKey[];
    const outcome = await elicitForm(ctx, "Enter the LINE and Open WebUI settings. They are encrypted and stored; the values are not shown back.", {
      type: "object",
      properties: Object.fromEntries(keys.map((k) => [k, { type: "string", ...FORM_FIELDS[k] }])),
      required: keys,
    });
    if (outcome.action === "unsupported") {
      return "This client cannot show the secure form. Use a client that supports elicitation (Open WebUI) to set the LINE credentials.";
    }
    if (outcome.action !== "accept") return "LINE credential update cancelled. Nothing was stored.";

    const values = {} as Record<LineSecretKey, string>;
    for (const k of keys) {
      const raw = outcome.content[k];
      if (typeof raw !== "string" || raw.trim() === "" || !isValidValue(raw.trim())) {
        throw new Error(`"${FORM_FIELDS[k].title}" is required and must be at most 4096 characters`);
      }
      values[k] = raw.trim();
    }

    // Claim the owner slot only now, so a cancelled form leaves no owner behind.
    // claimPublicSecret never overwrites, so if another account won the race it returns false.
    const claimed = await claimPublicSecret(LINE_SERVICE, LINE_OWNER_NAME, sub, sub);
    if (!claimed) {
      const owner = await getLineOwnerSub();
      if (owner !== sub) throw new Error(NOT_OWNER);
    }

    for (const k of keys) {
      await setSecret(sub, LINE_SERVICE, LINE_SECRETS[k], values[k]);
    }
    return claimed
      ? "You are now the LINE bot owner. The credentials were stored. The values were not shown."
      : "The LINE credentials were stored. The values were not shown.";
  },
};

/** Presence and metadata for one stored secret. Never the value. */
async function describeStored(owner: string | null, name: string) {
  if (!owner) return { set: false };
  const meta = await getSecretMeta(owner, LINE_SERVICE, name);
  if (!meta) return { set: false };
  return { set: true, scope: meta.scope, updatedAt: meta.updatedAt, updatedBy: meta.updatedBy };
}

const configTool: McpTool = {
  name: "line_check_config",
  description:
    "Check the LINE bridge configuration: whether a bot owner is recorded, which stored credentials are set " +
    "(presence and timestamps only, never values), non-secret settings, and a format check on the channel secret. " +
    "Does not call any external service.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => {
    const { owner, stored: values } = await readLineState();

    const stored: Record<string, unknown> = {};
    for (const key of Object.keys(LINE_SECRETS) as LineSecretKey[]) {
      stored[LINE_SECRETS[key]] = await describeStored(owner, LINE_SECRETS[key]);
    }

    const channelSecret = values.channelSecret;
    const formatChecks = {
      // LINE channel secrets are 32 hexadecimal characters. Only the boolean is reported.
      channel_secret_looks_valid: channelSecret ? /^[0-9a-f]{32}$/i.test(channelSecret) : null,
    };

    const openWebUiUrl = getOpenWebUIUrl() ?? null;
    const profileSet = owner ? (await readUserProfile(owner)) !== null : false;
    const missing = [
      ...(owner ? [] : ["bot owner (run line_set_credentials)"]),
      ...(Object.keys(LINE_SECRETS) as LineSecretKey[])
        .filter((k) => !values[k])
        .map((k) => `stored ${LINE_SECRETS[k]}`),
      ...(openWebUiUrl ? [] : ["OPEN_WEBUI_URL"]),
    ];

    return JSON.stringify(
      {
        ready: missing.length === 0 && formatChecks.channel_secret_looks_valid !== false,
        owner_recorded: owner !== null,
        user_profile_set: profileSet,
        missing_required: missing,
        stored_secrets: stored,
        settings: { OPEN_WEBUI_URL: openWebUiUrl },
        format_checks: formatChecks,
        webhook_path: "/api/line/webhook",
      },
      null,
      2,
    );
  },
};

const apiTool: McpTool = {
  name: "line_check_api",
  description:
    "Check the LINE Messaging API connection with the stored channel access token: bot info and the webhook endpoint " +
    "LINE has on record. Set send_webhook_test to true to ask LINE to send a test event to that endpoint " +
    "(needs the tunnel and agent-service to be up).",
  inputSchema: {
    type: "object",
    properties: {
      send_webhook_test: { type: "boolean", description: "Ask LINE to send a test event to the webhook (default false)" },
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    if (args.send_webhook_test !== undefined && typeof args.send_webhook_test !== "boolean") {
      throw new Error('"send_webhook_test" must be true or false');
    }
    let token: string;
    try {
      token = (await getLineConfig()).channelAccessToken;
    } catch (err) {
      if (err instanceof LineConfigError) throw err;
      throw new Error("LINE is not configured");
    }

    const report: Record<string, unknown> = { api_base: LINE_API_BASE };
    const check = async <T>(label: string, fn: () => Promise<T>): Promise<T | { error: string }> => {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof LineApiError) return { error: err.message };
        console.warn(`line_check_api: ${label} failed`);
        return { error: `${label} failed` };
      }
    };

    report.bot = await check("bot info", () => getBotInfo(token));
    report.webhook_endpoint = await check("webhook endpoint", () => getWebhookEndpoint(token));
    if (args.send_webhook_test === true) {
      report.webhook_test = await check("webhook test", () => testWebhookEndpoint(token));
    }
    return JSON.stringify(report, null, 2);
  },
};

const tunnelTool: McpTool = {
  name: "line_check_tunnel",
  description:
    "Check the ngrok tunnel that exposes the LINE webhook (public URLs from the ngrok agent API) and whether " +
    "Open WebUI, which answers the messages, is reachable from agent-service.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => {
    const report: Record<string, unknown> = {};

    try {
      const res = await fetch(`${getNgrokApiUrl()}/api/tunnels`, {
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { tunnels?: { public_url?: string; proto?: string }[] };
      const tunnels = (body.tunnels ?? []).map((t) => ({ public_url: t.public_url, proto: t.proto }));
      const https = tunnels.find((t) => t.public_url?.startsWith("https://"));
      report.ngrok = {
        reachable: true,
        tunnels,
        webhook_url: https?.public_url ? `${https.public_url}/api/line/webhook` : null,
      };
    } catch (err) {
      report.ngrok = { reachable: false, reason: err instanceof Error ? err.message : "unknown error" };
    }

    const baseUrl = getOpenWebUIUrl();
    if (!baseUrl) {
      report.open_webui = { reachable: false, reason: "OPEN_WEBUI_URL is not set" };
    } else {
      try {
        const res = await fetch(`${baseUrl}/api/config`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
        report.open_webui = { reachable: res.ok, status: res.status };
      } catch (err) {
        report.open_webui = { reachable: false, reason: err instanceof Error ? err.message : "unknown error" };
      }
    }
    return JSON.stringify(report, null, 2);
  },
};

export const lineServer: McpServerDef = {
  name: "line",
  version: "0.6.0",
  tools: [setCredentialsTool, setProfileTool, configTool, apiTool, tunnelTool],
};
