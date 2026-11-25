import { tool } from "ai";
import { z } from "zod";
import { appConfig } from "@/config/app.config";
import { isUuid, matchDeliveryZone, normalizeBdPhone, searchProductList } from "@/lib/commerce";
import type { Customer, OrderQuote, Repo } from "@/lib/repo/types";

export interface ToolContext {
  repo: Repo;
  pageId: string;
  customer: Customer;
  /** A quote prepared during this model turn; the caller sends a deterministic summary instead of model prose. */
  state: { preparedQuote: OrderQuote | null };
}

function money(n: number): string {
  return `${n}${appConfig.currency}`;
}

export function formatOrderQuoteSummary(quote: OrderQuote): string {
  const items = quote.items.map((item) => `${item.name} ×${item.qty}`).join(", ");
  return `অর্ডার সারাংশ: ${items}; পণ্যের মোট ${money(quote.subtotal)}, ডেলিভারি ${money(quote.delivery_charge)}, সর্বমোট ${money(quote.subtotal + quote.delivery_charge)}। ডেলিভারি ${quote.delivery_eta}; ঠিকানা: ${quote.address}। কনফার্ম করতে “হ্যাঁ” লিখুন।`;
}

/**
 * All tools are bound to ONE tenant (pageId) and ONE customer. The model can never pass a
 * pageId/customerId. Price, stock and delivery are read from the current database state.
 * This tool only creates a short-lived quote; only the application can consume it after consent.
 */
export function createTools(ctx: ToolContext) {
  const { repo, pageId, customer, state } = ctx;

  return {
    searchProducts: tool({
      description:
        "প্রোডাক্ট খুঁজে নাম, দাম, স্টক ও আইডি দেয়। দাম/স্টক বলার আগে অবশ্যই এটি কল করো। ফাঁকা query দিলে সাধারণ তালিকা আসে।",
      inputSchema: z.object({
        query: z.string().max(100).describe("প্রোডাক্টের নাম/ক্যাটাগরি/কীওয়ার্ড, যেমন 'পাঞ্জাবি'"),
      }),
      execute: async ({ query }) => {
        try {
          const all = await repo.listProducts(pageId);
          const found = searchProductList(all, query, 5);
          return {
            count: found.length,
            products: found.map((p) => ({
              productId: p.id,
              name: p.name,
              price: p.price,
              stock: p.stock,
              inStock: p.stock > 0,
              category: p.category,
              details: p.description.slice(0, 120),
            })),
            note: found.length === 0 ? "কোনো মিল পাওয়া যায়নি, কিছু বানিয়ে বলবে না।" : undefined,
          };
        } catch (e) {
          console.error("[tool:searchProducts]", e);
          return { count: 0, products: [], error: "LOOKUP_FAILED" };
        }
      },
    }),

    checkStock: tool({
      description: "নির্দিষ্ট প্রোডাক্টের চাহিদার পরিমাণ স্টকে আছে কি না যাচাই করে (অর্ডার কনফার্মের আগে)।",
      inputSchema: z.object({
        productId: z.string().describe("searchProducts থেকে পাওয়া productId"),
        quantity: z.number().int().min(1).max(50).default(1),
      }),
      execute: async ({ productId, quantity }) => {
        try {
          if (!isUuid(productId)) return { ok: false, error: "PRODUCT_NOT_FOUND" };
          const all = await repo.listProducts(pageId);
          const p = all.find((x) => x.id === productId);
          if (!p) return { ok: false, error: "PRODUCT_NOT_FOUND" };
          return {
            ok: true,
            name: p.name,
            unitPrice: p.price,
            available: p.stock,
            enough: p.stock >= quantity,
            lineTotal: p.price * quantity,
          };
        } catch (e) {
          console.error("[tool:checkStock]", e);
          return { ok: false, error: "LOOKUP_FAILED" };
        }
      },
    }),

    getDeliveryCharge: tool({
      description: "কাস্টমারের ঠিকানা/এলাকা অনুযায়ী যাচাইকৃত ডেলিভারি চার্জ ও আনুমানিক সময় জানায়।",
      inputSchema: z.object({
        address: z.string().min(2).max(300).describe("এলাকা বা পূর্ণ ঠিকানা"),
      }),
      execute: async ({ address }) => {
        try {
          const zones = await repo.getDeliveryZones(pageId);
          const m = matchDeliveryZone(zones, address);
          if (!m) return { ok: false, error: "DELIVERY_ZONE_UNVERIFIED" };
          return {
            ok: true,
            zone: m.zone.name,
            charge: m.zone.charge,
            eta: m.zone.eta,
            matchedBy: m.matchedKeyword,
          };
        } catch (e) {
          console.error("[tool:getDeliveryCharge]", e);
          return { ok: false, error: "LOOKUP_FAILED" };
        }
      },
    }),

    prepareOrderQuote: tool({
      description:
        "শুধু অর্ডারের যাচাইকৃত সারাংশ তৈরি করে; অর্ডার জমা দেয় না। কাস্টমারের পণ্য, পরিমাণ, নাম, বাংলাদেশি ফোন ও পূর্ণ ঠিকানা নিশ্চিত হলে কল করো। সারাংশ দেখানোর পর কেবল আলাদা turn-এ স্পষ্ট সম্মতিতেই সিস্টেম অর্ডার জমা দেবে।",
      inputSchema: z.object({
        name: z.string().min(2).max(80),
        phone: z.string().min(10).max(20).describe("বাংলাদেশি মোবাইল নম্বর"),
        address: z.string().min(8).max(300).describe("পূর্ণ ঠিকানা"),
        items: z
          .array(z.object({ productId: z.string(), quantity: z.number().int().min(1).max(20) }))
          .min(1)
          .max(10),
        note: z.string().max(200).optional().describe("সাইজ/কালার বা বিশেষ নির্দেশনা"),
      }),
      execute: async ({ name, phone, address, items, note }) => {
        try {
          const customerName = name.trim();
          const fullAddress = address.trim();
          const normalizedPhone = normalizeBdPhone(phone);
          if (customerName.length < 2 || fullAddress.length < 8) return { ok: false, error: "INVALID_ORDER_DETAILS" };
          if (!normalizedPhone) return { ok: false, error: "INVALID_PHONE" };
          if (items.some((i) => !isUuid(i.productId))) return { ok: false, error: "PRODUCT_NOT_FOUND" };

          const merged = new Map<string, number>();
          for (const item of items) {
            const qty = (merged.get(item.productId) ?? 0) + item.quantity;
            if (qty > 50) return { ok: false, error: "QUANTITY_LIMIT_EXCEEDED" };
            merged.set(item.productId, qty);
          }
          if ([...merged.values()].reduce((sum, qty) => sum + qty, 0) > 100) {
            return { ok: false, error: "QUANTITY_LIMIT_EXCEEDED" };
          }

          const [products, zones] = await Promise.all([repo.listProducts(pageId), repo.getDeliveryZones(pageId)]);
          const quoteItems = [];
          let subtotal = 0;
          for (const [productId, qty] of merged) {
            const product = products.find((p) => p.id === productId);
            if (!product) return { ok: false, error: "PRODUCT_NOT_FOUND" };
            if (product.stock < qty) {
              return { ok: false, error: "OUT_OF_STOCK", product: product.name, available: product.stock };
            }
            quoteItems.push({ product_id: product.id, name: product.name, qty, unit_price: product.price });
            subtotal += product.price * qty;
          }
          const match = matchDeliveryZone(zones, fullAddress);
          if (!match) return { ok: false, error: "DELIVERY_ZONE_UNVERIFIED" };

          // Keep transcript context compact and avoid forwarding/storing order PII on later turns.
          await repo.redactOrderDetails(pageId, customer.id, fullAddress);
          const quote = await repo.createOrderQuote({
            page_id: pageId,
            customer_id: customer.id,
            customer_name: customerName,
            phone: normalizedPhone,
            address: fullAddress,
            items: quoteItems,
            subtotal,
            delivery_zone_id: match.zone.id,
            delivery_zone_name: match.zone.name,
            delivery_charge: match.zone.charge,
            delivery_eta: match.zone.eta,
            note: note?.trim() || null,
          });
          state.preparedQuote = quote;
          return {
            ok: true,
            items: quote.items.map(({ name: productName, qty, unit_price }) => ({ name: productName, qty, unitPrice: unit_price })),
            subtotal: quote.subtotal,
            deliveryCharge: quote.delivery_charge,
            total: quote.subtotal + quote.delivery_charge,
            deliveryEta: quote.delivery_eta,
            expiresAt: quote.expires_at,
            note: "Quote only. This call did not place or reserve an order.",
          };
        } catch (e) {
          console.error("[tool:prepareOrderQuote]", e);
          return { ok: false, error: "QUOTE_FAILED" };
        }
      },
    }),
  };
}

export type BikribotTools = ReturnType<typeof createTools>;
