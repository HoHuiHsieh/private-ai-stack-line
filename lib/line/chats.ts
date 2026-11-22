import { randomUUID } from "node:crypto";
import { getSecret, setSecret } from "../secrets/store";
import { LINE_SERVICE } from "./config";
import type { OpenWebUIConnection } from "./chat";

/**
 * One persistent Open WebUI chat per LINE conversation (user, group, or room), so conversations show in the sidebar and keep history.
 *
 * The completion itself stays stateless. Passing chat_id to /api/chat/completions makes Open WebUI run
 * its frontend turn logic, which needs message ids this bridge does not have (it returns HTTP 409).
 * Instead, after each answer, the user and assistant messages are appended to the chat with
 * POST /api/v1/chats/{id}.
 *
 * Open WebUI assigns the chat id (a UUID), so the mapping from LINE user to chat id is stored encrypted
 * for the bot owner (service "line", name "chat_<conversationId>", where the id is a userId, groupId, or roomId).
 */

const CHAT_PREFIX = "chat_";
const TIMEOUT_MS = 15_000;

type HistoryMessage = {
  id: string;
  parentId: string | null;
  childrenIds: string[];
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  models: string[];
  done?: boolean;
};

type History = { messages: Record<string, HistoryMessage>; currentId: string | null };

function authHeaders(conn: OpenWebUIConnection): HeadersInit {
  return { Authorization: `Bearer ${conn.apiKey}`, "Content-Type": "application/json" };
}

export async function getOrCreateChatId(
  owner: string,
  conversationId: string,
  conn: OpenWebUIConnection,
  model: string,
): Promise<string> {
  const name = `${CHAT_PREFIX}${conversationId}`;
  const existing = await getSecret(owner, LINE_SERVICE, name);
  if (existing) return existing;

  const res = await fetch(`${conn.baseUrl}/api/v1/chats/new`, {
    method: "POST",
    headers: authHeaders(conn),
    body: JSON.stringify({
      chat: {
        title: "LINE",
        models: [model],
        history: { messages: {}, currentId: null },
        messages: [],
        params: {},
        tags: [],
      },
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Open WebUI could not create a chat: HTTP ${res.status}`);

  const data = (await res.json()) as { id?: unknown };
  if (typeof data.id !== "string" || data.id === "") throw new Error("Open WebUI returned no chat id");

  await setSecret(owner, LINE_SERVICE, name, data.id);
  return data.id;
}

/** Appends one user message and its answer to the chat's history, then saves the chat. */
export async function appendChatTurn(
  conn: OpenWebUIConnection,
  chatId: string,
  model: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  const getRes = await fetch(`${conn.baseUrl}/api/v1/chats/${encodeURIComponent(chatId)}`, {
    headers: authHeaders(conn),
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!getRes.ok) throw new Error(`Open WebUI could not load the chat: HTTP ${getRes.status}`);
  const current = (await getRes.json()) as { chat?: Record<string, unknown> };
  const chat = current.chat ?? {};

  const history: History = {
    messages: ((chat.history as History | undefined)?.messages ?? {}) as Record<string, HistoryMessage>,
    currentId: ((chat.history as History | undefined)?.currentId ?? null) as string | null,
  };

  const now = Math.floor(Date.now() / 1000);
  const userId = randomUUID();
  const assistantId = randomUUID();
  const parent = history.currentId;

  if (parent && history.messages[parent]) {
    history.messages[parent].childrenIds = [...history.messages[parent].childrenIds, userId];
  }
  history.messages[userId] = {
    id: userId,
    parentId: parent,
    childrenIds: [assistantId],
    role: "user",
    content: userText,
    timestamp: now,
    models: [model],
  };
  history.messages[assistantId] = {
    id: assistantId,
    parentId: userId,
    childrenIds: [],
    role: "assistant",
    content: assistantText,
    timestamp: now,
    models: [model],
    done: true,
  };
  history.currentId = assistantId;

  // The flat message list follows the current branch, as the frontend stores it.
  const path: HistoryMessage[] = [];
  for (let id: string | null = assistantId; id; id = history.messages[id]?.parentId ?? null) {
    path.unshift(history.messages[id]);
  }

  const postRes = await fetch(`${conn.baseUrl}/api/v1/chats/${encodeURIComponent(chatId)}`, {
    method: "POST",
    headers: authHeaders(conn),
    body: JSON.stringify({ chat: { ...chat, history, messages: path } }),
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!postRes.ok) throw new Error(`Open WebUI could not save the chat: HTTP ${postRes.status}`);
}

/**
 * The last `limit` user/assistant messages on the chat's current branch, oldest first.
 * This is the conversation Open WebUI has saved, so it survives restarts and reloads.
 */
export async function loadChatHistory(
  conn: OpenWebUIConnection,
  chatId: string,
  limit: number,
): Promise<{ role: "user" | "assistant"; content: string }[]> {
  if (limit <= 0) return [];
  const res = await fetch(`${conn.baseUrl}/api/v1/chats/${encodeURIComponent(chatId)}`, {
    headers: authHeaders(conn),
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Open WebUI could not load the chat: HTTP ${res.status}`);
  const data = (await res.json()) as { chat?: { history?: Partial<History> } };
  const history = data.chat?.history ?? {};
  const messages = history.messages ?? {};

  const path: HistoryMessage[] = [];
  for (let id = history.currentId ?? null; id && messages[id]; id = messages[id].parentId) {
    path.unshift(messages[id]);
  }
  return path
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content !== "")
    .slice(-limit)
    .map((m) => ({ role: m.role, content: m.content }));
}
