import { isExplicitOrderConsent } from "@/lib/commerce";
import type { ChatMessage, ConfirmOrderQuoteResult, OrderQuote, Repo } from "@/lib/repo/types";
import { formatOrderQuoteSummary } from "./tools";

export type QuoteConsentCheck =
  | { handled: false }
  | { handled: true; quote: OrderQuote; result: ConfirmOrderQuoteResult };

/** Removes order PII from stale message snapshots before they can be reused as model context. */
export function redactQuotePiiFromHistory(history: ChatMessage[], quote: OrderQuote): ChatMessage[] {
  return history.map((message) => {
    let content = message.content;
    if (quote.address) content = content.split(quote.address).join("[ঠিকানা গোপন]");
    content = content.replace(/(?:\+?880)?0?1[3-9][0-9০-৯]{8}/gu, "[ফোন গোপন]");
    return { ...message, content };
  });
}

/**
 * The only application path from a pending quote to order confirmation. Consent must be a
 * standalone affirmative after the exact deterministic summary stored in the conversation.
 */
export async function checkAndConsumeQuoteConsent(input: {
  repo: Repo;
  pageId: string;
  customerId: string;
  text: string;
  history: ChatMessage[];
  quote: OrderQuote | null;
}): Promise<QuoteConsentCheck> {
  const { repo, pageId, customerId, text, history, quote } = input;
  if (!quote) return { handled: false };

  const previousAssistant = history.slice(0, -1).reverse().find((message) => message.role === "assistant");
  const exactSummaryWasSent = previousAssistant?.content === formatOrderQuoteSummary(quote);
  if (!isExplicitOrderConsent(text) || !exactSummaryWasSent) {
    await repo.invalidatePendingOrderQuote(pageId, customerId);
    await repo.redactOrderDetails(pageId, customerId, quote.address);
    return { handled: false };
  }

  const result = await repo.confirmOrderQuote(pageId, customerId, quote.id);
  if (!result.ok) await repo.invalidatePendingOrderQuote(pageId, customerId);
  await repo.redactOrderDetails(pageId, customerId, quote.address);
  return { handled: true, quote, result };
}
