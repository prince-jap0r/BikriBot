/**
 * Local PostgreSQL repository (fallback for dev/sandbox when Supabase env vars are absent).
 * Same contract as the Supabase repo. On first use it applies supabase/schema.sql (idempotent).
 */
import fs from "node:fs";
import path from "node:path";
import { pool } from "@/db";
import type {
  ChatMessage,
  ConfirmOrderQuoteResult,
  CreateOrderQuoteInput,
  Customer,
  DeliveryZone,
  Memory,
  Order,
  OrderQuote,
  PageRow,
  Product,
  Repo,
  Stats,
} from "./types";

let schemaReady: Promise<void> | null = null;

function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    if (process.env.NODE_ENV === "production") {
      // Production schemas must be applied as a deployment/migration step, never by a request.
      schemaReady = Promise.resolve();
    } else {
      schemaReady = (async () => {
        const file = path.join(process.cwd(), "supabase", "schema.sql");
        const ddl = fs.readFileSync(file, "utf8");
        await pool.query(ddl);
      })().catch((e) => {
        schemaReady = null;
        throw e;
      });
    }
  }
  return schemaReady;
}

/** Runs a SELECT and returns JSON-friendly rows (timestamps → ISO strings). */
async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  await ensureSchema();
  const res = await pool.query(`select to_jsonb(x) as r from (${sql}) x`, params);
  return res.rows.map((r: { r: T }) => r.r);
}

async function exec(sql: string, params: unknown[] = []) {
  await ensureSchema();
  return pool.query(sql, params);
}

export function createPostgresRepo(): Repo {
  return {
    driver: "postgres",

    async ping() {
      try {
        await ensureSchema();
        await pool.query("select 1");
        return true;
      } catch {
        return false;
      }
    },

    async getPage(pageId) {
      const r = await rows<PageRow>("select * from pages where page_id = $1", [pageId]);
      return r[0] ?? null;
    },

    async listPages() {
      return rows<PageRow>("select * from pages order by created_at");
    },

    async upsertPage(p) {
      await exec(
        `insert into pages (page_id, shop_name, agent_name, shop_info, page_access_token, is_active)
         values ($1, coalesce($2,'আমাদের শপ'), coalesce($3,'রাহি'), coalesce($4,''), $5, coalesce($6,true))
         on conflict (page_id) do update set
           shop_name = coalesce($2, pages.shop_name),
           agent_name = coalesce($3, pages.agent_name),
           shop_info = coalesce($4, pages.shop_info),
           page_access_token = coalesce($5, pages.page_access_token),
           is_active = coalesce($6, pages.is_active)`,
        [
          p.page_id,
          p.shop_name ?? null,
          p.agent_name ?? null,
          p.shop_info ?? null,
          p.page_access_token ?? null,
          p.is_active ?? null,
        ],
      );
    },

    async getOrCreateCustomer(pageId, psid) {
      await exec(
        "insert into customers (page_id, psid) values ($1, $2) on conflict (page_id, psid) do nothing",
        [pageId, psid],
      );
      const r = await rows<Customer>("select * from customers where page_id = $1 and psid = $2", [
        pageId,
        psid,
      ]);
      return r[0];
    },

    async updateCustomer(customerId, patch) {
      const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
      if (entries.length === 0) return;
      const allowed = new Set(["name", "phone", "stage", "psych_type"]);
      const safe = entries.filter(([k]) => allowed.has(k));
      if (safe.length === 0) return;
      const sets = safe.map(([k], i) => `${k} = $${i + 2}`).join(", ");
      const res = await exec(`update customers set ${sets} where id = $1`, [customerId, ...safe.map(([, v]) => v)]);
      if (res.rowCount === 0) throw new Error("Customer not found");
    },

    async listCustomers(pageId, limit) {
      return rows<Customer>(
        "select * from customers where page_id = $1 order by last_message_at desc limit $2",
        [pageId, limit],
      );
    },

    async recordMessage(pageId, customerId, role, content, fbMid) {
      const res = await exec(
        `insert into messages (page_id, customer_id, role, content, fb_mid)
         values ($1, $2, $3, $4, $5) on conflict do nothing`,
        [pageId, customerId, role, content, fbMid ?? null],
      );
      if (res.rowCount === 0) return false;
      return true;
    },

    async recentMessages(customerId, limit) {
      const r = await rows<ChatMessage>(
        "select role, content, created_at from messages where customer_id = $1 order by created_at desc limit $2",
        [customerId, limit],
      );
      return r.reverse();
    },

    async getMemory(customerId) {
      const r = await rows<Memory>("select * from customer_memories where customer_id = $1", [customerId]);
      return r[0] ?? null;
    },

    async upsertMemory(m) {
      await exec(
        `insert into customer_memories
           (customer_id, page_id, summary, preferences, last_address, last_order_summary, total_orders, updated_at)
         values ($1,$2,$3,$4::jsonb,$5,$6,$7, now())
         on conflict (customer_id) do update set
           summary = excluded.summary, preferences = excluded.preferences,
           last_address = excluded.last_address, last_order_summary = excluded.last_order_summary,
           total_orders = excluded.total_orders, updated_at = now()`,
        [
          m.customer_id,
          m.page_id,
          m.summary,
          JSON.stringify(m.preferences ?? {}),
          m.last_address,
          m.last_order_summary,
          m.total_orders,
        ],
      );
    },

    async listProducts(pageId, opts) {
      return rows<Product>(
        `select * from products where page_id = $1 ${opts?.includeInactive ? "" : "and is_active"}
         order by created_at limit 500`,
        [pageId],
      );
    },

    async upsertProduct(pageId, p) {
      const vals = [
        pageId,
        p.sku ?? null,
        p.name,
        p.description ?? "",
        p.category ?? "",
        p.price,
        p.stock,
        p.is_active ?? true,
      ];
      if (p.id) {
        const res = await exec(
          `update products set sku=$2, name=$3, description=$4, category=$5, price=$6, stock=$7, is_active=$8
           where id = $9 and page_id = $1`,
          [...vals, p.id],
        );
        if (res.rowCount === 0) throw new Error("Product not found for page");
      } else {
        await exec(
          `insert into products (page_id, sku, name, description, category, price, stock, is_active)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          vals,
        );
      }
    },

    async getDeliveryZones(pageId) {
      return rows<DeliveryZone>("select * from delivery_zones where page_id = $1 order by charge", [pageId]);
    },

    async createOrderQuote(input: CreateOrderQuoteInput) {
      await exec("update order_quotes set status = 'cancelled' where page_id = $1 and customer_id = $2 and status = 'pending'", [input.page_id, input.customer_id]);
      const res = await exec(
        `insert into order_quotes (page_id, customer_id, customer_name, phone, address, items, subtotal,
           delivery_zone_id, delivery_zone_name, delivery_charge, delivery_eta, note)
         values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12) returning to_jsonb(order_quotes) as r`,
        [input.page_id, input.customer_id, input.customer_name, input.phone, input.address, JSON.stringify(input.items), input.subtotal, input.delivery_zone_id, input.delivery_zone_name, input.delivery_charge, input.delivery_eta, input.note],
      );
      if (!res.rows[0]?.r) throw new Error("Could not create order quote");
      return res.rows[0].r as OrderQuote;
    },

    async redactOrderDetails(pageId, customerId, address) {
      await exec(
        `update messages set content = regexp_replace(replace(content, $3, '[ঠিকানা গোপন]'),
           '((\\+?880)?0?1[3-9][0-9০-৯]{8})', '[ফোন গোপন]', 'g')
         where page_id = $1 and customer_id = $2 and position($3 in content) > 0
            or page_id = $1 and customer_id = $2 and content ~ '((\\+?880)?0?1[3-9][0-9০-৯]{8})'`,
        [pageId, customerId, address],
      );
    },

    async getPendingOrderQuote(pageId, customerId) {
      const r = await rows<OrderQuote>("select * from order_quotes where page_id = $1 and customer_id = $2 and status = 'pending' order by created_at desc limit 1", [pageId, customerId]);
      return r[0] ?? null;
    },

    async invalidatePendingOrderQuote(pageId, customerId) {
      await exec("update order_quotes set status = 'cancelled' where page_id = $1 and customer_id = $2 and status = 'pending'", [pageId, customerId]);
    },

    async confirmOrderQuote(pageId, customerId, quoteId) {
      await ensureSchema();
      const res = await pool.query("select bikribot_confirm_order_quote($1::uuid,$2,$3::uuid) as r", [quoteId, pageId, customerId]);
      return res.rows[0].r as ConfirmOrderQuoteResult;
    },

    async listOrders(pageId, limit) {
      return rows<Order>("select * from orders where page_id = $1 order by created_at desc limit $2", [
        pageId,
        limit,
      ]);
    },

    async updateOrderStatus(pageId, orderId, status) {
      const res = await exec("update orders set status = $3 where id = $2 and page_id = $1", [pageId, orderId, status]);
      if (res.rowCount === 0) throw new Error("Order not found for page");
    },

    async stats(pageId): Promise<Stats> {
      const r = await rows<Stats>(
        `select
           (select count(*) from customers where page_id = $1)::int as customers,
           (select count(*) from messages where page_id = $1)::int as messages,
           (select count(*) from orders where page_id = $1)::int as orders,
           (select coalesce(sum(total),0) from orders where page_id = $1 and status <> 'cancelled')::int as revenue,
           (select count(*) from products where page_id = $1)::int as products`,
        [pageId],
      );
      return r[0];
    },
  };
}
