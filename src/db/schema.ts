// Drizzle mirror of supabase/schema.sql for typed PostgreSQL access.
// The source of truth for Supabase is supabase/schema.sql (also holds the order function + seed).
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const pages = pgTable("pages", {
  pageId: text("page_id").primaryKey(),
  shopName: text("shop_name").notNull().default("আমাদের শপ"),
  agentName: text("agent_name").notNull().default("রাহি"),
  shopInfo: text("shop_info").notNull().default(""),
  pageAccessToken: text("page_access_token"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageId: text("page_id").notNull(),
    sku: text("sku"),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    category: text("category").notNull().default(""),
    price: integer("price").notNull(),
    stock: integer("stock").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("products_page_sku_uq").on(t.pageId, t.sku),
    index("products_page_idx").on(t.pageId),
  ],
);

export const deliveryZones = pgTable(
  "delivery_zones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageId: text("page_id").notNull(),
    name: text("name").notNull(),
    keywords: text("keywords").array().notNull().default(sql`'{}'::text[]`),
    charge: integer("charge").notNull(),
    eta: text("eta").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("delivery_zones_page_idx").on(t.pageId)],
);

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageId: text("page_id").notNull(),
    psid: text("psid").notNull(),
    name: text("name"),
    phone: text("phone"),
    stage: text("stage").notNull().default("greeting"),
    psychType: text("psych_type").notNull().default("unknown"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("customers_page_psid_uq").on(t.pageId, t.psid)],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageId: text("page_id").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    fbMid: text("fb_mid"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("messages_customer_idx").on(t.customerId, t.createdAt.desc()),
    uniqueIndex("messages_page_mid_uq")
      .on(t.pageId, t.fbMid)
      .where(sql`${t.fbMid} is not null`),
  ],
);

export const customerMemories = pgTable("customer_memories", {
  customerId: uuid("customer_id")
    .primaryKey()
    .references(() => customers.id, { onDelete: "cascade" }),
  pageId: text("page_id").notNull(),
  summary: text("summary").notNull().default(""),
  preferences: jsonb("preferences").notNull().default(sql`'{}'::jsonb`),
  lastAddress: text("last_address"),
  lastOrderSummary: text("last_order_summary"),
  totalOrders: integer("total_orders").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderNo: text("order_no").notNull().unique(),
    pageId: text("page_id").notNull(),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    customerName: text("customer_name").notNull(),
    phone: text("phone").notNull(),
    address: text("address").notNull(),
    items: jsonb("items").notNull(),
    itemsHash: text("items_hash").notNull().default(""),
    subtotal: integer("subtotal").notNull(),
    deliveryCharge: integer("delivery_charge").notNull().default(0),
    total: integer("total").notNull(),
    status: text("status").notNull().default("pending"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("orders_page_idx").on(t.pageId, t.createdAt.desc()),
    index("orders_customer_idx").on(t.customerId, t.itemsHash),
  ],
);

export const orderQuotes = pgTable(
  "order_quotes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageId: text("page_id").notNull(),
    customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
    customerName: text("customer_name").notNull(),
    phone: text("phone").notNull(),
    address: text("address").notNull(),
    items: jsonb("items").notNull(),
    subtotal: integer("subtotal").notNull(),
    deliveryZoneId: uuid("delivery_zone_id").notNull().references(() => deliveryZones.id),
    deliveryZoneName: text("delivery_zone_name").notNull(),
    deliveryCharge: integer("delivery_charge").notNull(),
    deliveryEta: text("delivery_eta").notNull(),
    note: text("note"),
    status: text("status").notNull().default("pending"),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull().default(sql`now() + interval '15 minutes'`),
  },
  (t) => [
    uniqueIndex("order_quotes_one_pending_per_customer").on(t.pageId, t.customerId).where(sql`${t.status} = 'pending'`),
    index("order_quotes_expiry_idx").on(t.expiresAt).where(sql`${t.status} = 'pending'`),
  ],
);
