/**
 * Speech-to-text through Speaches (faster-whisper), which serves the OpenAI-compatible
 * POST /v1/audio/transcriptions route. The URL and model come from the "audio" / "standard" tier of
 * models.json (see lib/models/config.ts).
 */

import { getModel } from "../models/config";

const TIMEOUT_MS = 120_000;

export class TranscriptionError extends Error {}

/** Transcribes one audio file and returns the recognised text (may be empty if no speech was found). */
export async function transcribeAudio(data: Buffer, filename: string, contentType: string): Promise<string> {
  const { baseUrl, model } = getModel("audio", "standard");

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(data)], { type: contentType || "application/octet-stream" }), filename);
  form.append("model", model);
  form.append("response_format", "json");

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      body: form,
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new TranscriptionError(`speech service unreachable: ${err instanceof Error ? err.message : "unknown error"}`);
  }
  if (!res.ok) throw new TranscriptionError(`speech service failed: HTTP ${res.status}`);

  const body = (await res.json()) as { text?: unknown };
  if (typeof body.text !== "string") throw new TranscriptionError("speech service returned no text");
  return body.text.trim();
}
