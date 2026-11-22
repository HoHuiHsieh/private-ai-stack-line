import { readFileSync } from "node:fs";

/**
 * Loads models.json: tiered model configuration for this service. Categories are llm, vlm, embedding and
 * audio. Each category maps tier names (fast, standard, premium, ...) to a model on a named source.
 *
 * API keys live in the gitignored models.json. A tracked example may contain placeholders,
 * but never real credentials.
 *
 * The file is read once, on first use, and validated as a whole. A broken file fails loudly with the
 * path of the problem, so it is never half-applied.
 */

export const MODEL_CATEGORIES = ["llm", "vlm", "embedding", "audio"] as const;
export type ModelCategory = (typeof MODEL_CATEGORIES)[number];

const SOURCE_TYPES = ["openai", "anthropic", "ollama", "openai-compatible"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** Default endpoints for hosted providers. Local servers must give a baseUrl. */
const DEFAULT_BASE_URL: Partial<Record<SourceType, string>> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
};

type SourceEntry = { type: SourceType; baseUrl?: string; apiKey?: string };
type TierEntry = { source: string; model: string; dimensions?: number; task?: string };
export type ModelsFile = {
  version: 1;
  sources: Record<string, SourceEntry>;
  models: Partial<Record<ModelCategory, { tiers: Record<string, TierEntry> }>>;
};

export type ResolvedModel = {
  category: ModelCategory;
  tier: string;
  source: string;
  type: SourceType;
  baseUrl: string;
  apiKey?: string;
  model: string;
  dimensions?: number;
  task?: string;
};

export class ModelConfigError extends Error {}

const DEFAULT_PATH = "/app/config/models.json";
let cached: ModelsFile | null = null;

function fail(message: string): never {
  throw new ModelConfigError(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${where} must be a non-empty string`);
  return value.trim();
}

/** Parses and validates the file text. Throws ModelConfigError naming the first problem. */
export function parseModelsConfig(text: string): ModelsFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail("models.json is not valid JSON");
  }
  if (!isObject(raw)) fail("models.json must be a JSON object");
  if (raw.version !== 1) fail('models.json: "version" must be 1');

  if (!isObject(raw.sources)) fail('models.json: "sources" must be an object');
  const sources: Record<string, SourceEntry> = {};
  for (const [name, value] of Object.entries(raw.sources)) {
    const where = `sources.${name}`;
    if (!isObject(value)) fail(`${where} must be an object`);
    const type = value.type;
    if (typeof type !== "string" || !(SOURCE_TYPES as readonly string[]).includes(type)) {
      fail(`${where}.type must be one of ${SOURCE_TYPES.join(", ")}`);
    }
    if (value.apiKeyEnv !== undefined) {
      fail(`${where}.apiKeyEnv is no longer supported; configure apiKey in the gitignored models.json`);
    }
    const entry: SourceEntry = { type: type as SourceType };
    if (value.baseUrl !== undefined) entry.baseUrl = nonEmptyString(value.baseUrl, `${where}.baseUrl`);
    if (value.apiKey !== undefined) entry.apiKey = nonEmptyString(value.apiKey, `${where}.apiKey`);
    if (entry.type === "ollama" || entry.type === "openai-compatible") {
      if (!entry.baseUrl) fail(`${where}.baseUrl is required for type ${entry.type}`);
    }
    sources[name] = entry;
  }

  if (!isObject(raw.models)) fail('models.json: "models" must be an object');
  const models: ModelsFile["models"] = {};
  for (const [category, block] of Object.entries(raw.models)) {
    if (!(MODEL_CATEGORIES as readonly string[]).includes(category)) {
      fail(`models.${category}: category must be one of ${MODEL_CATEGORIES.join(", ")}`);
    }
    if (!isObject(block) || !isObject(block.tiers)) fail(`models.${category}.tiers must be an object`);
    const tiers: Record<string, TierEntry> = {};
    for (const [tier, value] of Object.entries(block.tiers)) {
      const where = `models.${category}.tiers.${tier}`;
      if (!isObject(value)) fail(`${where} must be an object`);
      const source = nonEmptyString(value.source, `${where}.source`);
      if (!sources[source]) fail(`${where}.source "${source}" is not defined in sources`);
      const entry: TierEntry = { source, model: nonEmptyString(value.model, `${where}.model`) };
      if (value.dimensions !== undefined) {
        if (!Number.isInteger(value.dimensions) || (value.dimensions as number) <= 0) {
          fail(`${where}.dimensions must be a positive integer`);
        }
        entry.dimensions = value.dimensions as number;
      }
      if (value.task !== undefined) {
        if (value.task !== "transcription" && value.task !== "speech") {
          fail(`${where}.task must be "transcription" or "speech"`);
        }
        entry.task = value.task;
      }
      tiers[tier] = entry;
    }
    models[category as ModelCategory] = { tiers };
  }

  return { version: 1, sources, models };
}

/** The validated models.json, read once. */
export function loadModelsConfig(): ModelsFile {
  if (!cached) {
    const path = process.env.MODELS_CONFIG_PATH?.trim() || DEFAULT_PATH;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      fail(`models.json not found at ${path}`);
    }
    cached = parseModelsConfig(text);
  }
  return cached;
}

/**
 * The model for a category and tier, with its source resolved. Throws ModelConfigError when the tier is
 * missing.
 */
export function getModel(category: ModelCategory, tier = "standard"): ResolvedModel {
  const config = loadModelsConfig();
  const block = config.models[category];
  if (!block) fail(`models.json has no "${category}" models`);
  const entry = block.tiers[tier];
  if (!entry) fail(`models.json has no "${tier}" tier for ${category}`);
  const source = config.sources[entry.source];

  const baseUrl = source.baseUrl ?? DEFAULT_BASE_URL[source.type];
  if (!baseUrl) fail(`source "${entry.source}" has no baseUrl`);

  return {
    category,
    tier,
    source: entry.source,
    type: source.type,
    baseUrl: baseUrl.replace(/\/$/, ""),
    apiKey: source.apiKey,
    model: entry.model,
    dimensions: entry.dimensions,
    task: entry.task,
  };
}
