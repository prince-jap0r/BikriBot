import { generateText, isStepCount, type ModelMessage } from "ai";
import { aiConfig } from "@/config/ai.config";
import { appConfig } from "@/config/app.config";
import { getRepo } from "@/lib/repo";
import type { ChatMessage, OrderQuote, PageRow } from "@/lib/repo/types";
import { updateMemoryAfterTurn } from "./memory-updater";
import { checkAndConsumeQuoteConsent, redactQuotePiiFromHistory } from "./order-consent";
import { buildSystemPrompt } from "./prompt-loader";
import { getFallbackModel, getPrimaryModel } from "./provider";
import { createTools, formatOrderQuoteSummary } from "./tools";

export interface AgentInput {
  pageId: string;
  psid: string;
  text: string;
  /** Facebook message id – used for de-duplicating webhook retries. */
  fbMid?: string | null;
}

export interface AgentResult {
  reply: string;
  failed: boolean;
  error?: string;
  modules: string[];
  stage: string;
  tools: string[];
  model: string;
  approxPromptTokens: number;
  /** Run after the reply has been delivered (memory / stage / psych update). Never throws. */
  finalize: () => Promise<void>;
}

const SAFE_FALLBACK_REPLY = "দুঃখিত, একটু সমস্যা হচ্ছে। কিছুক্ষণ পর আবার মেসেজ দিন, আমি দেখছি।";
const EMPTY_REPLY_FALLBACK = "এক মিনিট, চেক করে জানাচ্ছি।";

/** Removes markdown/list artefacts so replies read like a human chat message. */
export function sanitizeReply(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "")
    .replace(/`+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Merges consecutive same-role messages (some providers require strict alternation) and trims size. */
function toModelMessages(history: ChatMessage[]): ModelMessage[] {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of history) {
    const content = m.content.slice(0, 700);
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += `\n${content}`;
    else out.push({ role: m.role, content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

function defaultPage(pageId: string): PageRow {
  return {
    page_id: pageId,
    shop_name: appConfig.defaultShopName,
    agent_name: "রাহি",
    shop_info: "",
    page_access_token: null,
    is_active: true,
  };
}

function money(n: number): string {
  return `${n}${appConfig.currency}`;
}

function confirmedOrderReply(order: { order_no: string; total: number }): string {
  return `অর্ডার কনফার্ম হয়েছে, #${order.order_no}। মোট ${money(order.total)}।`;
}

function quoteFailureReply(error: string): string {
  if (error === "OUT_OF_STOCK") return "দুঃখিত, যাচাই করার সময় স্টক বদলে গেছে। আগের সারাংশের সম্মতি কার্যকর হয়নি; চাইলে নতুন করে স্টক ও দাম যাচাই করে জানাই।";
  if (error === "QUOTE_EXPIRED" || error === "QUOTE_STALE") return "দাম, স্টক বা ডেলিভারির তথ্য বদলেছে, তাই আগের সারাংশ আর কার্যকর নয়। চাইলে নতুন করে যাচাই করে সারাংশ দিতে পারি।";
  return "এই অর্ডার সারাংশটি আর নিশ্চিত করা যাচ্ছে না। চাইলে নতুন করে পণ্য, ঠিকানা ও চার্জ যাচাই করে সারাংশ দেব।";
}

/**
 * Core orchestrator for ONE incoming customer message. Orders are created only by consuming
 * a persisted quote after an exact standalone affirmative to the deterministic prior summary.
 * Returns null when the message must be ignored (duplicate delivery or inactive page).
 */
export async function runAgent(input: AgentInput): Promise<AgentResult | null> {
  const repo = await getRepo();
  const pageId = input.pageId;
  const text = input.text.slice(0, appConfig.maxIncomingChars).trim();
  if (!text) return null;

  const page = (await repo.getPage(pageId)) ?? defaultPage(pageId);
  if (!page.is_active) return null;

  const customer = await repo.getOrCreateCustomer(pageId, input.psid);
  const isNew = await repo.recordMessage(pageId, customer.id, "user", text, input.fbMid ?? null);
  if (!isNew) return null; // duplicate webhook delivery

  const [memory, history, pendingQuote] = await Promise.all([
    repo.getMemory(customer.id),
    repo.recentMessages(customer.id, aiConfig.historyLimit),
    repo.getPendingOrderQuote(pageId, customer.id),
  ]);

  const consentCheck = await checkAndConsumeQuoteConsent({
    repo,
    pageId,
    customerId: customer.id,
    text,
    history,
    quote: pendingQuote,
  });
  if (consentCheck.handled) {
    const { result } = consentCheck;
    if (result.ok) {
        // The database RPC is the commit point; subsequent bookkeeping is best-effort only.
        if (!result.duplicate) {
          try {
            const fresh = await repo.getMemory(customer.id);
            const summary = result.items.map((item) => `${item.name} ×${item.qty}`).join(", ");
            await repo.upsertMemory({
              customer_id: customer.id,
              page_id: pageId,
              summary: fresh?.summary ?? "",
              preferences: fresh?.preferences ?? {},
              last_address: null,
              last_order_summary: `${result.order_no}: ${summary} (${money(result.total)})`,
              total_orders: (fresh?.total_orders ?? 0) + 1,
            });
          } catch (e) {
            console.error("[agent] order committed; bookkeeping deferred:", e instanceof Error ? e.message : "unknown error");
          }
        }
        const reply = confirmedOrderReply(result);
        try {
          await repo.recordMessage(pageId, customer.id, "assistant", reply, null);
        } catch (e) {
          console.error("[agent] order committed; confirmation transcript save failed:", e instanceof Error ? e.message : "unknown error");
        }
        return {
          reply,
          failed: false,
          modules: ["core", "flow:closing", "db"],
          stage: "ordered",
          tools: ["confirmOrderQuote"],
          model: "server-confirmed",
          approxPromptTokens: 0,
          finalize: async () => {},
        };
      }

    const reply = quoteFailureReply(result.error);
    await repo.recordMessage(pageId, customer.id, "assistant", reply, null);
    return {
        reply,
        failed: false,
        modules: ["core", "flow:closing", "db"],
        stage: "closing",
        tools: ["confirmOrderQuote"],
        model: "server-validation",
        approxPromptTokens: 0,
        finalize: async () => {},
    };
  }

  // A pending quote may have caused PII redaction above. Do not pass the stale copy
  // loaded before that redaction to the model on this same turn.
  const promptHistory = pendingQuote
    ? redactQuotePiiFromHistory(await repo.recentMessages(customer.id, aiConfig.historyLimit), pendingQuote)
    : history;
  const prompt = buildSystemPrompt({ page, customer, memory, userText: text });
  const messages = toModelMessages(promptHistory);
  const state: { preparedQuote: OrderQuote | null } = { preparedQuote: null };
  const tools = createTools({ repo, pageId, customer, state });

  const attempt = async (modelId: string, model: ReturnType<typeof getPrimaryModel>) => {
    const result = await generateText({
      model,
      system: prompt.system,
      messages,
      tools,
      stopWhen: isStepCount(aiConfig.maxSteps),
      temperature: aiConfig.temperature,
      maxOutputTokens: aiConfig.maxOutputTokens,
      abortSignal: AbortSignal.timeout(aiConfig.timeoutMs),
    });
    const used = result.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName as string));
    return { text: result.text, used, modelId };
  };

  let outcome: { text: string; used: string[]; modelId: string } | null = null;
  let errorMessage: string | undefined;
  try {
    outcome = await attempt(aiConfig.defaultModel, getPrimaryModel());
  } catch (e) {
    errorMessage = e instanceof Error ? e.message : String(e);
    console.error("[agent] primary model failed:", errorMessage);
    // Never retry after a quote side effect; it must be shown exactly as persisted.
    if (!state.preparedQuote) {
      try {
        const fb = getFallbackModel();
        if (fb) {
          outcome = await attempt(aiConfig.fallbackModel, fb);
          errorMessage = undefined;
        }
      } catch (e2) {
        errorMessage = e2 instanceof Error ? e2.message : String(e2);
        console.error("[agent] fallback model failed:", errorMessage);
      }
    }
  }

  const stage = state.preparedQuote ? "closing" : prompt.effectiveStage;
  const base = {
    modules: prompt.modules,
    stage,
    approxPromptTokens: prompt.approxTokens,
  };

  if (state.preparedQuote) {
    const reply = formatOrderQuoteSummary(state.preparedQuote);
    await repo.recordMessage(pageId, customer.id, "assistant", reply, null);
    return {
      ...base,
      reply,
      failed: false,
      tools: ["prepareOrderQuote"],
      model: outcome?.modelId ?? aiConfig.defaultModel,
      finalize: async () => {},
    };
  }

  if (!outcome) {
    return {
      ...base,
      reply: SAFE_FALLBACK_REPLY,
      failed: true,
      error: errorMessage,
      tools: [],
      model: aiConfig.defaultModel,
      finalize: async () => {},
    };
  }

  const reply = sanitizeReply(outcome.text) || EMPTY_REPLY_FALLBACK;
  await repo.recordMessage(pageId, customer.id, "assistant", reply, null);

  return {
    ...base,
    reply,
    failed: false,
    tools: outcome.used,
    model: outcome.modelId,
    finalize: () =>
      updateMemoryAfterTurn({
        repo,
        pageId,
        customer,
        userText: text,
        reply,
        orderPlaced: false,
      }),
  };
}
