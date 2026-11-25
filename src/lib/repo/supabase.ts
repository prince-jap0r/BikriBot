import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  ChatMessage,
  ConfirmOrderQuoteResult,
  CreateOrderQuoteInput,
  Customer,
  CustomerPatch,
  DeliveryZone,
  Memory,
  Order,
  OrderQuote,
  PageRow,
  Product,
  ProductInput,
  Repo,
  Stats,
} from "./types";

function unwrap<T>(res: { data: T | null; error: { message: string; code?: string } | null }): T {
  if (res.error) throw new Error(`Supabase: ${res.error.message}`);
  return res.data as T;
}

function unwrapAffected(res: { data: unknown; error: { message: string; code?: string } | null }, operation: string): void {
  const data = unwrap(res);
  if (data === null || (Array.isArray(data) && data.length === 0)) {
    throw new Error(`Supabase: ${operation} did not affect a row`);
  }
}

export function createSupabaseRepo(): Repo {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");

  const sb: SupabaseClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return {
    driver: "supabase",

    async ping() {
      const { error } = await sb.from("pages").select("page_id", { head: true, count: "exact" });
      return !error;
    },

    async getPage(pageId) {
      const res = await sb.from("pages").select("*").eq("page_id", pageId).maybeSingle();
      return unwrap<PageRow | null>(res);
    },

    async listPages() {
      const res = await sb.from("pages").select("*").order("created_at");
      return unwrap<PageRow[]>(res);
    },

    async upsertPage(page) {
      unwrap(await sb.from("pages").upsert(page, { onConflict: "page_id" }));
    },

    async getOrCreateCustomer(pageId, psid) {
      const find = async () =>
        unwrap<Customer | null>(
          await sb.from("customers").select("*").eq("page_id", pageId).eq("psid", psid).maybeSingle(),
        );
      const existing = await find();
      if (existing) return existing;
      const ins = await sb.from("customers").insert({ page_id: pageId, psid }).select("*").single();
      if (ins.error) {
        // Race: another request created it first.
        const again = await find();
        if (again) return again;
        throw new Error(`Supabase: ${ins.error.message}`);
      }
      return ins.data as Customer;
    },

    async updateCustomer(customerId, patch: CustomerPatch) {
      if (Object.keys(patch).length === 0) return;
      unwrapAffected(await sb.from("customers").update(patch).eq("id", customerId).select("id"), "customer update");
    },

    async listCustomers(pageId, limit) {
      const res = await sb
        .from("customers")
        .select("*")
        .eq("page_id", pageId)
        .order("last_message_at", { ascending: false })
        .limit(limit);
      return unwrap<Customer[]>(res);
    },

    async recordMessage(pageId, customerId, role, content, fbMid) {
      const ins = await sb.from("messages").insert({
        page_id: pageId,
        customer_id: customerId,
        role,
        content,
        fb_mid: fbMid ?? null,
      });
      if (ins.error) {
        if (ins.error.code === "23505") return false; // duplicate mid
        throw new Error(`Supabase: ${ins.error.message}`);
      }
      return true;
    },

    async recentMessages(customerId, limit) {
      const res = await sb
        .from("messages")
        .select("role, content, created_at")
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false })
        .limit(limit);
      return unwrap<ChatMessage[]>(res).reverse();
    },

    async getMemory(customerId) {
      const res = await sb.from("customer_memories").select("*").eq("customer_id", customerId).maybeSingle();
      return unwrap<Memory | null>(res);
    },

    async upsertMemory(memory) {
      unwrap(
        await sb
          .from("customer_memories")
          .upsert({ ...memory, updated_at: new Date().toISOString() }, { onConflict: "customer_id" }),
      );
    },

    async listProducts(pageId, opts) {
      let q = sb.from("products").select("*").eq("page_id", pageId);
      if (!opts?.includeInactive) q = q.eq("is_active", true);
      const res = await q.order("created_at").limit(500);
      return unwrap<Product[]>(res);
    },

    async upsertProduct(pageId, p: ProductInput) {
      const row = {
        page_id: pageId,
        sku: p.sku ?? null,
        name: p.name,
        description: p.description ?? "",
        category: p.category ?? "",
        price: p.price,
        stock: p.stock,
        is_active: p.is_active ?? true,
      };
      if (p.id) {
        unwrapAffected(await sb.from("products").update(row).eq("id", p.id).eq("page_id", pageId).select("id"), "product update");
      } else {
        unwrap(await sb.from("products").insert(row));
      }
    },

    async getDeliveryZones(pageId) {
      const res = await sb.from("delivery_zones").select("*").eq("page_id", pageId).order("charge");
      return unwrap<DeliveryZone[]>(res);
    },

    async createOrderQuote(input: CreateOrderQuoteInput) {
      unwrap(await sb.from("order_quotes").update({ status: "cancelled" }).eq("page_id", input.page_id).eq("customer_id", input.customer_id).eq("status", "pending"));
      const res = await sb.from("order_quotes").insert(input).select("*").single();
      return unwrap<OrderQuote>(res);
    },

    async redactOrderDetails(pageId, customerId, address) {
      unwrap(await sb.rpc("bikribot_redact_order_details", {
        p_page_id: pageId,
        p_customer_id: customerId,
        p_address: address,
      }));
    },

    async getPendingOrderQuote(pageId, customerId) {
      const res = await sb.from("order_quotes").select("*").eq("page_id", pageId).eq("customer_id", customerId).eq("status", "pending").order("created_at", { ascending: false }).limit(1).maybeSingle();
      return unwrap<OrderQuote | null>(res);
    },

    async invalidatePendingOrderQuote(pageId, customerId) {
      unwrap(await sb.from("order_quotes").update({ status: "cancelled" }).eq("page_id", pageId).eq("customer_id", customerId).eq("status", "pending"));
    },

    async confirmOrderQuote(pageId, customerId, quoteId) {
      const res = await sb.rpc("bikribot_confirm_order_quote", {
        p_quote_id: quoteId,
        p_page_id: pageId,
        p_customer_id: customerId,
      });
      return unwrap<ConfirmOrderQuoteResult>(res);
    },

    async listOrders(pageId, limit) {
      const res = await sb
        .from("orders")
        .select("*")
        .eq("page_id", pageId)
        .order("created_at", { ascending: false })
        .limit(limit);
      return unwrap<Order[]>(res);
    },

    async updateOrderStatus(pageId, orderId, status) {
      unwrapAffected(await sb.from("orders").update({ status }).eq("id", orderId).eq("page_id", pageId).select("id"), "order status update");
    },

    async stats(pageId): Promise<Stats> {
      const count = async (table: string) => {
        const { count: c, error } = await sb
          .from(table)
          .select("*", { count: "exact", head: true })
          .eq("page_id", pageId);
        if (error) throw new Error(`Supabase: ${error.message}`);
        return c ?? 0;
      };
      const [customers, messages, orders, products] = await Promise.all([
        count("customers"),
        count("messages"),
        count("orders"),
        count("products"),
      ]);
      let revenue = 0;
      for (let offset = 0; ; offset += 1000) {
        const rev = await sb
          .from("orders")
          .select("total")
          .eq("page_id", pageId)
          .neq("status", "cancelled")
          .order("created_at", { ascending: true })
          .range(offset, offset + 999);
        if (rev.error) throw new Error(`Supabase: ${rev.error.message}`);
        const rows = (rev.data as { total: number }[] | null) ?? [];
        revenue += rows.reduce((sum, row) => sum + row.total, 0);
        if (rows.length < 1000) break;
      }
      return { customers, messages, orders, revenue, products };
    },
  };
}
