/** Domain types + the Repository contract (implemented for Supabase and local Postgres). */

export const STAGES = [
  "greeting",
  "discovery",
  "product",
  "objection",
  "closing",
  "ordered",
  "after_sales",
] as const;
export type Stage = (typeof STAGES)[number];

export const PSYCH_TYPES = [
  "unknown",
  "price",
  "quality",
  "trust",
  "unsure",
  "ready",
] as const;
export type PsychType = (typeof PSYCH_TYPES)[number];

export interface PageRow {
  page_id: string;
  shop_name: string;
  agent_name: string;
  shop_info: string;
  page_access_token: string | null;
  is_active: boolean;
}

export interface Product {
  id: string;
  page_id: string;
  sku: string | null;
  name: string;
  description: string;
  category: string;
  price: number;
  stock: number;
  is_active: boolean;
}

export interface ProductInput {
  id?: string;
  sku?: string | null;
  name: string;
  description?: string;
  category?: string;
  price: number;
  stock: number;
  is_active?: boolean;
}

export interface DeliveryZone {
  id: string;
  page_id: string;
  name: string;
  keywords: string[];
  charge: number;
  eta: string;
}

export interface Customer {
  id: string;
  page_id: string;
  psid: string;
  name: string | null;
  phone: string | null;
  stage: Stage;
  psych_type: PsychType;
  created_at: string;
  last_message_at: string;
}

export interface CustomerPatch {
  name?: string | null;
  phone?: string | null;
  stage?: Stage;
  psych_type?: PsychType;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export interface Memory {
  customer_id: string;
  page_id: string;
  summary: string;
  preferences: Record<string, unknown>;
  last_address: string | null;
  last_order_summary: string | null;
  total_orders: number;
}

export interface OrderItem {
  product_id: string;
  name: string;
  qty: number;
  unit_price: number;
}

export interface Order {
  id: string;
  order_no: string;
  page_id: string;
  customer_id: string | null;
  customer_name: string;
  phone: string;
  address: string;
  items: OrderItem[];
  subtotal: number;
  delivery_charge: number;
  total: number;
  status: string;
  note: string | null;
  created_at: string;
}

export interface OrderQuoteItem {
  product_id: string;
  name: string;
  qty: number;
  unit_price: number;
}

export interface OrderQuote {
  id: string;
  page_id: string;
  customer_id: string;
  customer_name: string;
  phone: string;
  address: string;
  items: OrderQuoteItem[];
  subtotal: number;
  delivery_zone_id: string;
  delivery_zone_name: string;
  delivery_charge: number;
  delivery_eta: string;
  note: string | null;
  expires_at: string;
  status: "pending" | "consumed" | "cancelled" | "expired" | "stale";
  order_id: string | null;
}

export type CreateOrderQuoteInput = Omit<OrderQuote, "id" | "expires_at" | "status" | "order_id">;

export type ConfirmOrderQuoteResult = CreateOrderResult | {
  ok: false;
  error: "QUOTE_NOT_FOUND" | "QUOTE_EXPIRED" | "QUOTE_STALE" | "QUOTE_INVALID";
};

export type CreateOrderResult =
  | {
      ok: true;
      duplicate: boolean;
      order_id: string;
      order_no: string;
      subtotal: number;
      delivery_charge: number;
      total: number;
      items: OrderItem[];
    }
  | {
      ok: false;
      error: "NO_ITEMS" | "PRODUCT_NOT_FOUND" | "OUT_OF_STOCK";
      product?: string;
      product_id?: string;
      available?: number;
    };

export interface Stats {
  customers: number;
  messages: number;
  orders: number;
  revenue: number;
  products: number;
}

export interface Repo {
  readonly driver: "supabase" | "postgres";
  ping(): Promise<boolean>;

  getPage(pageId: string): Promise<PageRow | null>;
  listPages(): Promise<PageRow[]>;
  upsertPage(page: Partial<PageRow> & { page_id: string }): Promise<void>;

  getOrCreateCustomer(pageId: string, psid: string): Promise<Customer>;
  updateCustomer(customerId: string, patch: CustomerPatch): Promise<void>;
  listCustomers(pageId: string, limit: number): Promise<Customer[]>;

  /** Returns false when the Facebook message id (mid) was already stored (duplicate delivery). */
  recordMessage(
    pageId: string,
    customerId: string,
    role: "user" | "assistant",
    content: string,
    fbMid?: string | null,
  ): Promise<boolean>;
  /** Oldest → newest. */
  recentMessages(customerId: string, limit: number): Promise<ChatMessage[]>;

  getMemory(customerId: string): Promise<Memory | null>;
  upsertMemory(memory: Memory): Promise<void>;

  listProducts(pageId: string, opts?: { includeInactive?: boolean }): Promise<Product[]>;
  upsertProduct(pageId: string, product: ProductInput): Promise<void>;
  getDeliveryZones(pageId: string): Promise<DeliveryZone[]>;

  createOrderQuote(input: CreateOrderQuoteInput): Promise<OrderQuote>;
  redactOrderDetails(pageId: string, customerId: string, address: string): Promise<void>;
  getPendingOrderQuote(pageId: string, customerId: string): Promise<OrderQuote | null>;
  invalidatePendingOrderQuote(pageId: string, customerId: string): Promise<void>;
  confirmOrderQuote(pageId: string, customerId: string, quoteId: string): Promise<ConfirmOrderQuoteResult>;

  listOrders(pageId: string, limit: number): Promise<Order[]>;
  updateOrderStatus(pageId: string, orderId: string, status: string): Promise<void>;
  stats(pageId: string): Promise<Stats>;
}
