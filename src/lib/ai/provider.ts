import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { activeApiKey, aiConfig, type AIConfig } from "@/config/ai.config";

/**
 * Builds a model instance for the ACTIVE provider (AI_PROVIDER).
 * Switching provider/model is purely an env change – no code edits.
 */
export function getModel(modelId: string, cfg: AIConfig = aiConfig): LanguageModel {
  if (!activeApiKey(cfg)) {
    throw new Error(`AI API key missing for provider "${cfg.provider}" (check .env)`);
  }

  if (cfg.provider === "openrouter") {
    const headers: Record<string, string> = {};
    if (cfg.openrouter.siteUrl) headers["HTTP-Referer"] = cfg.openrouter.siteUrl;
    if (cfg.openrouter.appName) headers["X-Title"] = cfg.openrouter.appName;
    const openrouter = createOpenRouter({
      apiKey: cfg.openrouter.apiKey,
      baseURL: cfg.openrouter.baseURL,
      headers,
    });
    return openrouter.chat(modelId);
  }

  const endpoint = cfg.compatible[cfg.provider];
  if (!endpoint.baseURL) {
    throw new Error(`Base URL missing for provider "${cfg.provider}"`);
  }
  const provider = createOpenAICompatible({
    name: cfg.provider,
    apiKey: endpoint.apiKey,
    baseURL: endpoint.baseURL,
  });
  return provider.chatModel(modelId);
}

export function getPrimaryModel(cfg: AIConfig = aiConfig): LanguageModel {
  return getModel(cfg.defaultModel, cfg);
}

export function getFallbackModel(cfg: AIConfig = aiConfig): LanguageModel | null {
  if (!cfg.fallbackModel || cfg.fallbackModel === cfg.defaultModel) return null;
  return getModel(cfg.fallbackModel, cfg);
}
