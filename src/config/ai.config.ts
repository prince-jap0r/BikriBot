/**
 * AI provider configuration.
 *
 * Switch provider with `AI_PROVIDER`:
 *   - openrouter (default) -> any model on OpenRouter via @openrouter/ai-sdk-provider
 *   - openai | gemini | anthropic | custom -> OpenAI-compatible endpoints via @ai-sdk/openai-compatible
 *
 * Models are plain strings, so changing model/provider never needs a code change.
 */

export type AIProviderId = "openrouter" | "openai" | "gemini" | "anthropic" | "custom";

export const SUPPORTED_PROVIDERS: AIProviderId[] = [
  "openrouter",
  "openai",
  "gemini",
  "anthropic",
  "custom",
];

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) ? n : fallback;
}

export interface ProviderEndpoint {
  apiKey: string;
  baseURL: string;
}

export interface AIConfig {
  provider: AIProviderId;
  defaultModel: string;
  fallbackModel: string;
  temperature: number;
  maxOutputTokens: number;
  /** Max tool-calling steps per customer message. */
  maxSteps: number;
  /** Number of past messages included in context (token control). */
  historyLimit: number;
  /** Per-call timeout (ms) – keeps us inside Vercel's function limit. */
  timeoutMs: number;
  openrouter: {
    apiKey: string;
    baseURL: string;
    siteUrl: string;
    appName: string;
  };
  compatible: Record<Exclude<AIProviderId, "openrouter">, ProviderEndpoint>;
}

export function getAIConfig(): AIConfig {
  const env = process.env;
  const requested = (env.AI_PROVIDER || "openrouter").toLowerCase() as AIProviderId;
  const provider = SUPPORTED_PROVIDERS.includes(requested) ? requested : "openrouter";

  return {
    provider,
    defaultModel: env.AI_DEFAULT_MODEL || "google/gemini-2.0-flash-001",
    fallbackModel: env.AI_FALLBACK_MODEL || "openai/gpt-4o-mini",
    temperature: num(env.AI_TEMPERATURE, 0.6),
    maxOutputTokens: num(env.AI_MAX_OUTPUT_TOKENS, 400),
    maxSteps: num(env.AI_MAX_STEPS, 6),
    historyLimit: num(env.AI_HISTORY_LIMIT, 12),
    timeoutMs: num(env.AI_TIMEOUT_MS, 40000),
    openrouter: {
      apiKey: env.OPENROUTER_API_KEY || "",
      baseURL: env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
      siteUrl: env.OPENROUTER_SITE_URL || "",
      appName: env.OPENROUTER_APP_NAME || "BikriBot",
    },
    compatible: {
      openai: {
        apiKey: env.OPENAI_API_KEY || "",
        baseURL: env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      },
      gemini: {
        apiKey: env.GEMINI_API_KEY || "",
        baseURL:
          env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai",
      },
      anthropic: {
        apiKey: env.ANTHROPIC_API_KEY || "",
        baseURL: env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1",
      },
      custom: {
        apiKey: env.CUSTOM_AI_API_KEY || "",
        baseURL: env.CUSTOM_AI_BASE_URL || "",
      },
    },
  };
}

export const aiConfig: AIConfig = getAIConfig();

/** Returns the API key for the active provider ('' if missing). */
export function activeApiKey(cfg: AIConfig = aiConfig): string {
  return cfg.provider === "openrouter"
    ? cfg.openrouter.apiKey
    : cfg.compatible[cfg.provider].apiKey;
}
