import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { buildSystemPrompt } from "@/lib/ai/prompt-loader";
import { checkAndConsumeQuoteConsent, redactQuotePiiFromHistory } from "@/lib/ai/order-consent";
import { sanitizeMemoryForModel } from "@/lib/ai/memory-updater";
import { createTools } from "@/lib/ai/tools";
import { isExplicitOrderConsent, matchDeliveryZone } from "@/lib/commerce";
import { verifyFacebookSignature } from "@/lib/facebook/signature";
import {
  isFacebookEventCountSafe,
  isFacebookWebhookPayloadShape,
  isProductionWebhookConfigSafe,
  MAX_FACEBOOK_WEBHOOK_EVENTS,
  readBoundedRequestBody,
} from "@/lib/facebook/webhook-safety";
import type { ChatMessage, OrderQuote, Repo } from "@/lib/repo/types";
import { formatOrderQuoteSummary } from "@/lib/ai/tools";
import { apiCall } from "@/components/api";
import { isServiceReady } from "@/lib/readiness";

const zone = (id: string, keywords: string[], charge: number) => ({
  id,
  page_id: "page-1",
  name: id,
  keywords,
  charge,
  eta: "1–2 দিন",
});

test("explicit order consent accepts only standalone affirmative phrases", () => {
  for (const yes of ["হ্যাঁ", "হ্যা", "জি", "জ্বি", "yes", "YES PLEASE", "confirm", "অর্ডার কনফার্ম করুন", "হ্যাঁ।"]) {
    assert.equal(isExplicitOrderConsent(yes), true, yes);
  }
  for (const no of ["ঠিক আছে", "হ্যাঁ, কিন্তু পরে", "yes but change the address", "না", "হ্যাঁ?", "maybe yes"]) {
    assert.equal(isExplicitOrderConsent(no), false, no);
  }
});

test("delivery matching rejects missing and ambiguous zones and selects the longest unique keyword", () => {
  assert.equal(matchDeliveryZone([], "ঢাকা, মিরপুর"), null);
  assert.equal(matchDeliveryZone([zone("default-a", [], 50), zone("default-b", [], 80)], "বরিশাল"), null);
  assert.equal(matchDeliveryZone([zone("a", ["মিরপুর"], 50), zone("b", ["মিরপুর"], 80)], "ঢাকা মিরপুর"), null);
  const match = matchDeliveryZone([zone("short", ["ঢাকা"], 80), zone("long", ["মিরপুর"], 50)], "ঢাকা মিরপুর");
  assert.equal(match?.zone.id, "long");
  assert.equal(matchDeliveryZone([zone("default", [], 100)], "বরিশাল")?.zone.id, "default");
});

test("system prompt excludes customer phone and saved full address", () => {
  const built = buildSystemPrompt({
    page: { shop_name: "দোকান", agent_name: "রাহি", shop_info: "" },
    customer: { name: "পরীক্ষা", phone: "01712345678", stage: "closing", psych_type: "ready" },
    memory: {
      customer_id: "customer-1",
      page_id: "page-1",
      summary: "ফোন 01712345678 | ঠিকানা: মিরপুর ১০, ঢাকা",
      preferences: { phone: "01712345678", address: "মিরপুর ১০, ঢাকা", color: "নীল" },
      last_address: "মিরপুর ১০, ঢাকা",
      last_order_summary: "অর্ডার 01712345678, ঠিকানা: মিরপুর ১০, ঢাকা",
      total_orders: 1,
    },
    userText: "হ্যাঁ",
  });
  assert.equal(built.system.includes("01712345678"), false);
  assert.equal(built.system.includes("মিরপুর ১০, ঢাকা"), false);
  assert.equal(built.system.includes("color: নীল"), true);
});

test("memory sanitizer removes legacy and generated phone/address details", () => {
  const safe = sanitizeMemoryForModel({
    summary: "কাস্টমার 01712345678; address: মিরপুর ১০, ঢাকা",
    preferences: {
      color: "নীল",
      phone: "01712345678",
      location: "ঠিকানা: মিরপুর ১০, ঢাকা",
      size: ["L", "বাসা: ধানমন্ডি ২৭, ঢাকা"],
      malformed: [7, null],
    },
  });
  const serialized = JSON.stringify(safe);
  assert.equal(serialized.includes("01712345678"), false);
  assert.equal(serialized.includes("মিরপুর ১০, ঢাকা"), false);
  assert.equal(serialized.includes("ধানমন্ডি ২৭, ঢাকা"), false);
  assert.equal("phone" in safe.preferences, false);
  assert.equal(safe.preferences.color, "নীল");
});

test("order quote tool result does not send phone or full address back to the model", async () => {
  const quote = makeQuote();
  const product = {
    id: quote.items[0]!.product_id,
    page_id: quote.page_id,
    sku: null,
    name: quote.items[0]!.name,
    description: "",
    category: "",
    price: quote.items[0]!.unit_price,
    stock: 5,
    is_active: true,
  };
  const repo = {
    listProducts: async () => [product],
    getDeliveryZones: async () => [zone(quote.delivery_zone_name, ["মিরপুর"], quote.delivery_charge)],
    redactOrderDetails: async () => {},
    createOrderQuote: async () => quote,
  } as unknown as Repo;
  const tools = createTools({
    repo,
    pageId: quote.page_id,
    customer: { id: quote.customer_id } as unknown as import("@/lib/repo/types").Customer,
    state: { preparedQuote: null },
  });
  const execute = tools.prepareOrderQuote.execute as unknown as (input: unknown) => Promise<unknown>;
  const result = await execute({
    name: quote.customer_name,
    phone: quote.phone,
    address: quote.address,
    items: [{ productId: product.id, quantity: 1 }],
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(quote.phone), false);
  assert.equal(serialized.includes(quote.address), false);
  assert.equal((result as { ok?: boolean }).ok, true);
});

function makeQuote(): OrderQuote {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    page_id: "page-1",
    customer_id: "00000000-0000-4000-8000-000000000002",
    customer_name: "পরীক্ষা",
    phone: "01712345678",
    address: "মিরপুর ১০, ঢাকা",
    items: [{ product_id: "00000000-0000-4000-8000-000000000003", name: "পাঞ্জাবি", qty: 1, unit_price: 1450 }],
    subtotal: 1450,
    delivery_zone_id: "00000000-0000-4000-8000-000000000004",
    delivery_zone_name: "ঢাকা",
    delivery_charge: 60,
    delivery_eta: "১–২ দিন",
    note: null,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    status: "pending",
    order_id: null,
  };
}

function makeRepo(calls: string[]): Repo {
  const success = {
    ok: true as const,
    duplicate: false,
    order_id: "00000000-0000-4000-8000-000000000005",
    order_no: "BB-TEST-1",
    subtotal: 1450,
    delivery_charge: 60,
    total: 1510,
    items: makeQuote().items,
  };
  return {
    invalidatePendingOrderQuote: async () => { calls.push("invalidate"); },
    redactOrderDetails: async () => { calls.push("redact"); },
    confirmOrderQuote: async (_pageId: string, _customerId: string, quoteId: string) => {
      calls.push(`confirm:${quoteId}`);
      return success;
    },
  } as unknown as Repo;
}

const historyFor = (quote: OrderQuote, answer: string): ChatMessage[] => [
  { role: "assistant", content: formatOrderQuoteSummary(quote), created_at: "2026-01-01T00:00:00Z" },
  { role: "user", content: answer, created_at: "2026-01-01T00:00:01Z" },
];

test("quote gate does not commit for no, ambiguous consent, or a mismatched summary", async () => {
  const quote = makeQuote();
  for (const answer of ["না", "হ্যাঁ, পরে", "yes but change it"]) {
    const calls: string[] = [];
    const result = await checkAndConsumeQuoteConsent({
      repo: makeRepo(calls), pageId: quote.page_id, customerId: quote.customer_id,
      text: answer, history: historyFor(quote, answer), quote,
    });
    assert.equal(result.handled, false);
    assert.deepEqual(calls, ["invalidate", "redact"]);
  }

  const calls: string[] = [];
  const mismatched = historyFor(quote, "হ্যাঁ");
  mismatched[0] = { ...mismatched[0], content: "অন্য সারাংশ" };
  const result = await checkAndConsumeQuoteConsent({
    repo: makeRepo(calls), pageId: quote.page_id, customerId: quote.customer_id,
    text: "হ্যাঁ", history: mismatched, quote,
  });
  assert.equal(result.handled, false);
  assert.deepEqual(calls, ["invalidate", "redact"]);
});

test("quote gate consumes only after exact summary plus standalone yes", async () => {
  const quote = makeQuote();
  const calls: string[] = [];
  const result = await checkAndConsumeQuoteConsent({
    repo: makeRepo(calls), pageId: quote.page_id, customerId: quote.customer_id,
    text: "হ্যাঁ", history: historyFor(quote, "হ্যাঁ"), quote,
  });
  assert.equal(result.handled, true);
  assert.equal(result.handled && result.result.ok, true);
  assert.deepEqual(calls, [`confirm:${quote.id}`, "redact"]);
});

test("stale quote transcript is sanitized before it can be reused as model context", () => {
  const quote = makeQuote();
  const transcript: ChatMessage[] = [
    { role: "assistant", content: formatOrderQuoteSummary(quote), created_at: "2026-01-01T00:00:00Z" },
    { role: "user", content: "আমার নম্বর 01712345678", created_at: "2026-01-01T00:00:01Z" },
  ];
  const safe = redactQuotePiiFromHistory(transcript, quote);
  assert.equal(safe.map((m) => m.content).join(" ").includes(quote.address), false);
  assert.equal(safe.map((m) => m.content).join(" ").includes(quote.phone), false);
});

test("Facebook signature verifies raw request content and fails closed", () => {
  const secret = "test-app-secret";
  const raw = '{"object":"page","entry":[]}';
  const digest = createHmac("sha256", secret).update(raw, "utf8").digest("hex");
  assert.equal(verifyFacebookSignature(raw, `sha256=${digest}`, secret), true);
  assert.equal(verifyFacebookSignature(raw, `sha256=${"0".repeat(64)}`, secret), false);
  assert.equal(verifyFacebookSignature(raw, null, secret), false);
  assert.equal(verifyFacebookSignature(raw, `sha256=${digest}`, ""), false);
  assert.equal(isProductionWebhookConfigSafe("production", false, secret), false);
  assert.equal(isProductionWebhookConfigSafe("production", true, ""), false);
  assert.equal(isProductionWebhookConfigSafe("production", true, secret), true);
  assert.equal(isProductionWebhookConfigSafe("development", false, ""), true);
});

test("bounded webhook reader accepts within limit and rejects oversized UTF-8 bytes", async () => {
  const ok = await readBoundedRequestBody(new Request("http://local", { method: "POST", body: "hello" }), 5);
  assert.equal(ok, "hello");
  const tooLarge = await readBoundedRequestBody(new Request("http://local", { method: "POST", body: "ঢাকা" }), 4);
  assert.equal(tooLarge, null);
});

test("webhook payload shape and event-count limits reject malformed and excessive batches", () => {
  assert.equal(isFacebookWebhookPayloadShape({ object: "page", entry: [{ messaging: [{ sender: { id: "1" } }] }] }), true);
  assert.equal(isFacebookWebhookPayloadShape({ object: "page", entry: [null] }), false);
  assert.equal(isFacebookWebhookPayloadShape({ object: "page", entry: [{ messaging: {} }] }), false);
  assert.equal(isFacebookWebhookPayloadShape({ object: "page", entry: [{ messaging: [null] }] }), false);
  assert.equal(isFacebookEventCountSafe(MAX_FACEBOOK_WEBHOOK_EVENTS), true);
  assert.equal(isFacebookEventCountSafe(MAX_FACEBOOK_WEBHOOK_EVENTS + 1), false);
  assert.equal(isFacebookEventCountSafe(-1), false);
  assert.equal(isFacebookEventCountSafe(Number.POSITIVE_INFINITY), false);
});

test("production readiness requires database, AI credentials, and secured webhook configuration", () => {
  assert.equal(isServiceReady({ database: true, production: true, aiProviderConfigured: true, webhookSecurityConfigured: true }), true);
  assert.equal(isServiceReady({ database: false, production: true, aiProviderConfigured: true, webhookSecurityConfigured: true }), false);
  assert.equal(isServiceReady({ database: true, production: true, aiProviderConfigured: false, webhookSecurityConfigured: true }), false);
  assert.equal(isServiceReady({ database: true, production: true, aiProviderConfigured: true, webhookSecurityConfigured: false }), false);
  assert.equal(isServiceReady({ database: true, production: false, aiProviderConfigured: false, webhookSecurityConfigured: false }), true);
});

test("shared API helper normalizes network and non-JSON errors instead of throwing", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error("offline"); };
    const network = await apiCall("secret", "/offline");
    assert.equal(network.ok, false);
    assert.equal(network.status, 0);
    assert.ok(network.data.error);

    globalThis.fetch = async () => new Response("not-json", { status: 502 });
    const badGateway = await apiCall("secret", "/bad-json");
    assert.equal(badGateway.ok, false);
    assert.equal(badGateway.status, 502);
    assert.ok(badGateway.data.error);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
