import { askOpenWebUI, type ChatMessage, type ContentPart } from "./chat";
import {
  getLineConfig,
  LINE_MAX_AUDIO_BYTES,
  LINE_MAX_IMAGE_BYTES,
  LINE_MAX_MESSAGES_PER_REPLY,
  LINE_TEXT_LIMIT,
  type LineConfig,
} from "./config";
import {
  getMessageContent,
  LineApiError,
  LineContentTooLargeError,
  pushMessage,
  replyMessage,
  type LineMessage,
} from "./api";
import { buildVariables, readUserProfile } from "./profile";
import { loadBotFeatures } from "./features";
import { loadBotToolIds } from "./tools";
import { transcribeAudio } from "../speech/whisper";
import { appendChatTurn, getOrCreateChatId, loadChatHistory } from "./chats";

/**
 * Bridges LINE webhook events to Open WebUI: text, image, and audio in, model answer out.
 * Images and audio are downloaded from LINE and sent inline to the model as content parts.
 * The saved chat and in-memory history keep only a text placeholder for media, not the bytes.
 *
 * A conversation is a one-to-one chat (userId), a group (groupId), or a room (roomId).
 * Each conversation gets its own saved Open WebUI chat and history. In groups and rooms the bot
 * answers only text messages that mention it.
 * Per-conversation history lives in process memory only (lost on restart, single replica assumed).
 */

export type LineMention = { index: number; length: number; isSelf?: boolean };

export type LineEvent = {
  type: string;
  replyToken?: string;
  source?: { type?: string; userId?: string; groupId?: string; roomId?: string };
  message?: {
    id?: string;
    type?: string;
    text?: string;
    mention?: { mentionees?: LineMention[] };
    packageId?: string;
    stickerId?: string;
    keywords?: string[];
  };
};

const MAX_CONVERSATIONS = 500;
const histories = new Map<string, ChatMessage[]>();

const GENERIC_ERROR = "Sorry, the assistant is unavailable right now. Please try again later.";
const NON_TEXT = "Only text, image, and audio messages are supported at the moment.";
const TOO_LARGE = "That file is too large for me to process. Please send a smaller one.";
const MEDIA_FAILED = "Sorry, I could not download that file from LINE. Please send it again.";
const TRANSCRIBE_FAILED = "Sorry, I could not transcribe that voice message. Please try again.";
const NO_SPEECH = "I could not hear any speech in that voice message. Please try again.";

const DEFAULT_IMAGE_PROMPT = "The user sent this image. Describe it and respond helpfully.";

/** The id that identifies a conversation and receives push messages: userId, groupId, or roomId. */
function conversationOf(source: LineEvent["source"]): string | null {
  if (source?.type === "user") return source.userId ?? null;
  if (source?.type === "group") return source.groupId ?? null;
  if (source?.type === "room") return source.roomId ?? null;
  return null;
}

function isGroupSource(source: LineEvent["source"]): boolean {
  return source?.type === "group" || source?.type === "room";
}

/**
 * For a text message in a group or room: the text with the bot's own mention removed, or null if
 * the bot was not mentioned. The result may be empty when the message was only the mention.
 */
export function textAfterSelfMention(text: string, mentionees: LineMention[] | undefined): string | null {
  const selfMentions = (mentionees ?? []).filter((m) => m.isSelf);
  if (selfMentions.length === 0) return null;
  // Remove the highest offsets first, so the earlier offsets stay valid. LINE offsets are UTF-16,
  // the same as JS string indexes.
  let result = text;
  for (const m of [...selfMentions].sort((a, b) => b.index - a.index)) {
    result = result.slice(0, m.index) + result.slice(m.index + m.length);
  }
  return result.trim();
}

function rememberTurn(conversationId: string, user: string, assistant: string, maxMessages: number): void {
  if (maxMessages === 0) return;
  const history = histories.get(conversationId) ?? [];
  history.push({ role: "user", content: user }, { role: "assistant", content: assistant });
  while (history.length > maxMessages) history.shift();
  // Keep the map bounded: drop the least recently active conversation first (Map keeps insertion order).
  histories.delete(conversationId);
  histories.set(conversationId, history);
  while (histories.size > MAX_CONVERSATIONS) histories.delete(histories.keys().next().value!);
}

/** Split into LINE text messages of at most LINE_TEXT_LIMIT characters, preferring line breaks. */
export function toLineMessages(text: string): LineMessage[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > LINE_TEXT_LIMIT) {
    let cut = rest.lastIndexOf("\n", LINE_TEXT_LIMIT);
    if (cut < LINE_TEXT_LIMIT / 2) cut = LINE_TEXT_LIMIT;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  chunks.push(rest);

  if (chunks.length > LINE_MAX_MESSAGES_PER_REPLY) {
    chunks.length = LINE_MAX_MESSAGES_PER_REPLY;
    chunks[LINE_MAX_MESSAGES_PER_REPLY - 1] += "\n\n(Reply truncated.)";
  }
  return chunks.map((t) => ({ type: "text", text: t }));
}

async function sendReply(cfg: LineConfig, event: LineEvent, messages: LineMessage[]): Promise<void> {
  const conversationId = conversationOf(event.source);
  if (event.replyToken) {
    try {
      await replyMessage(cfg.channelAccessToken, event.replyToken, messages);
      return;
    } catch (err) {
      // 400 usually means the reply token expired (the model was slow). Fall back to push.
      if (!(err instanceof LineApiError && err.status === 400) || !conversationId) throw err;
    }
  }
  if (!conversationId) throw new Error("Event has neither a usable reply token nor a conversation id");
  await pushMessage(cfg.channelAccessToken, conversationId, messages);
}

/** Adds this conversation's Open WebUI chat id for the model, so a scheduled task can target this chat. */
function withChatHint(
  content: string | ContentPart[],
  chatId: string | null,
  conversationId: string,
): string | ContentPart[] {
  if (!chatId) return content;
  const hint =
    `\n\n[Conversation context: this chat's id is ${chatId}, and the LINE conversation id is ${conversationId}. ` +
    "If the user asks for a reminder or a scheduled task, call schedule_reminder with chat_id and " +
    "line_conversation_id set to these values.]";
  if (typeof content === "string") return content + hint;
  return [...content, { type: "text", text: hint.trim() }];
}

/**
 * Runs one turn. userContent is what the model receives (text or multimodal parts);
 * historyText is what gets stored in history and the saved Open WebUI chat.
 */
async function handleUserTurn(
  cfg: LineConfig,
  event: LineEvent,
  conversationId: string,
  userContent: string | ContentPart[],
  historyText: string,
): Promise<void> {
  const conn = { baseUrl: cfg.openWebUiUrl, apiKey: cfg.openWebUiApiKey };

  // One saved Open WebUI chat per conversation. If it cannot be created, the reply is still sent.
  let chatId: string | null = null;
  try {
    chatId = await getOrCreateChatId(cfg.owner, conversationId, conn, cfg.model);
  } catch (err) {
    console.warn("LINE: no Open WebUI chat for this conversation:", err instanceof Error ? err.message : err);
  }

  // Context comes from the saved chat when there is one, so it survives restarts and hot reloads.
  // The in-process map is only the fallback.
  let prior: ChatMessage[];
  try {
    prior = chatId
      ? await loadChatHistory(conn, chatId, cfg.maxHistoryMessages)
      : (histories.get(conversationId) ?? []).slice(-cfg.maxHistoryMessages);
  } catch (err) {
    console.warn("LINE: could not load chat history; using in-memory history:", err instanceof Error ? err.message : err);
    prior = (histories.get(conversationId) ?? []).slice(-cfg.maxHistoryMessages);
  }
  // The model sees the chat id for this turn only (it is not saved to history). The scheduler tool
  // needs it to deliver reminders into this chat, since LINE requests carry no chat header.
  const messages: ChatMessage[] = [
    ...prior,
    { role: "user", content: withChatHint(userContent, chatId, conversationId) },
  ];

  let answer: string;
  try {
    const variables = buildVariables(await readUserProfile(cfg.owner));
    const toolIds = await loadBotToolIds();
    const features = await loadBotFeatures();
    answer = await askOpenWebUI(conn, cfg.model, messages, { variables, toolIds, features });
  } catch (err) {
    // Log the reason (no secrets are in these messages), then tell the user something generic.
    console.warn("LINE: Open WebUI request failed:", err instanceof Error ? err.message : err);
    await sendReply(cfg, event, [{ type: "text", text: GENERIC_ERROR }]);
    return;
  }
  rememberTurn(conversationId, historyText, answer, cfg.maxHistoryMessages);
  await sendReply(cfg, event, toLineMessages(answer));

  // Save the turn to the conversation's chat after the reply, so a save failure never delays or blocks it.
  if (chatId) {
    try {
      await appendChatTurn(conn, chatId, cfg.model, historyText, answer);
    } catch (err) {
      console.warn("LINE: could not save the turn to Open WebUI:", err instanceof Error ? err.message : err);
    }
  }
}

/** Image MIME type for the data URL. LINE images are JPEG or PNG in practice; anything else is sent as JPEG. */
function imageMime(contentType: string): string {
  return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(contentType) ? contentType : "image/jpeg";
}

/**
 * Voice message: transcribe with Whisper, then send the transcript to the chat model as text.
 * The chat model is not sent the audio itself, because the model server does not accept audio input.
 */
async function handleVoiceMessage(
  cfg: LineConfig,
  event: LineEvent,
  conversationId: string,
  data: Buffer,
  contentType: string,
): Promise<void> {
  let transcript: string;
  try {
    transcript = await transcribeAudio(data, "voice-message.m4a", contentType);
  } catch (err) {
    console.warn("LINE: transcription failed:", err instanceof Error ? err.message : err);
    await sendReply(cfg, event, [{ type: "text", text: TRANSCRIBE_FAILED }]);
    return;
  }
  if (transcript === "") {
    await sendReply(cfg, event, [{ type: "text", text: NO_SPEECH }]);
    return;
  }
  const userContent = `The user sent a voice message. Its transcript:\n\n${transcript}\n\nRespond to what they said.`;
  await handleUserTurn(cfg, event, conversationId, userContent, `[Voice message] ${transcript}`);
}

/** Downloads an image or audio message and handles it as one turn. */
async function handleMediaMessage(
  cfg: LineConfig,
  event: LineEvent,
  conversationId: string,
  kind: "image" | "audio",
): Promise<void> {
  const messageId = event.message?.id;
  if (!messageId) throw new Error("Media event has no message id");
  // LINE media messages carry no caption, so the default prompt always applies.
  const maxBytes = kind === "image" ? LINE_MAX_IMAGE_BYTES : LINE_MAX_AUDIO_BYTES;

  let content;
  try {
    content = await getMessageContent(cfg.channelAccessToken, messageId, maxBytes);
  } catch (err) {
    if (err instanceof LineContentTooLargeError) {
      await sendReply(cfg, event, [{ type: "text", text: TOO_LARGE }]);
      return;
    }
    console.warn("LINE: could not download media:", err instanceof Error ? err.message : err);
    await sendReply(cfg, event, [{ type: "text", text: MEDIA_FAILED }]);
    return;
  }

  if (kind === "audio") {
    await handleVoiceMessage(cfg, event, conversationId, content.data, content.contentType);
    return;
  }
  const base64 = content.data.toString("base64");
  const parts: ContentPart[] = [
    { type: "image_url", image_url: { url: `data:${imageMime(content.contentType)};base64,${base64}` } },
    { type: "text", text: DEFAULT_IMAGE_PROMPT },
  ];
  await handleUserTurn(cfg, event, conversationId, parts, "[Image sent]");
}

/**
 * Sticker: the webhook gives no image, only ids and (sometimes) LINE's keywords for the sticker.
 * The model receives those keywords as text. The sticker picture itself is not read.
 */
async function handleStickerMessage(cfg: LineConfig, event: LineEvent, conversationId: string): Promise<void> {
  const keywords = (event.message?.keywords ?? [])
    .filter((k): k is string => typeof k === "string" && k.trim() !== "")
    .map((k) => k.trim().slice(0, 64))
    .slice(0, 10);
  const prompt =
    keywords.length > 0
      ? `The user sent a LINE sticker. Its keywords are: ${keywords.join(", ")}. Respond naturally to the sticker.`
      : "The user sent a LINE sticker with no description. Respond naturally.";
  await handleUserTurn(cfg, event, conversationId, prompt, "[Sticker sent]");
}

/** Handle one webhook event. Errors are logged and never thrown to the webhook caller. */
export async function handleLineEvent(event: LineEvent): Promise<void> {
  if (event.type !== "message") return;
  const conversationId = conversationOf(event.source);
  if (!conversationId) return;
  try {
    const cfg = await getLineConfig();
    const message = event.message;

    if (isGroupSource(event.source)) {
      // Groups and rooms: answer only text that mentions the bot. Other messages are ignored silently,
      // so the bot does not reply to every line of group chatter.
      if (message?.type !== "text" || typeof message.text !== "string") return;
      const text = textAfterSelfMention(message.text, message.mention?.mentionees);
      if (text === null || text === "") return;
      await handleUserTurn(cfg, event, conversationId, text, text);
      return;
    }

    if (message?.type === "text" && typeof message.text === "string") {
      await handleUserTurn(cfg, event, conversationId, message.text, message.text);
    } else if (message?.type === "image" || message?.type === "audio") {
      await handleMediaMessage(cfg, event, conversationId, message.type);
    } else if (message?.type === "sticker") {
      await handleStickerMessage(cfg, event, conversationId);
    } else {
      await sendReply(cfg, event, [{ type: "text", text: NON_TEXT }]);
    }
  } catch (err) {
    console.error("LINE: failed to handle event:", err instanceof Error ? err.message : err);
  }
}

/** Test helper: clears per-conversation history. */
export function resetLineHistory(): void {
  histories.clear();
}
