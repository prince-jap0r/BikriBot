"use client";

import type { Customer, DeliveryZone, Order, Product, Stats } from "@/lib/repo/types";

export interface Overview {
  pageId: string;
  pages: {
    page_id: string;
    shop_name: string;
    agent_name: string;
    shop_info: string;
    is_active: boolean;
    has_token: boolean;
  }[];
  stats: Stats;
  orders: Order[];
  products: Product[];
  customers: Customer[];
  zones: DeliveryZone[];
  setup: {
    dbDriver: string;
    aiProvider: string;
    defaultModel: string;
    fallbackModel: string;
    aiKeySet: boolean;
    fbPageIdSet: boolean;
    fbPageTokenSet: boolean;
    fbVerifyTokenSet: boolean;
    fbAppSecretSet: boolean;
    signatureVerification: boolean;
    webhookPath: string;
  };
}

export async function apiCall<T>(
  secret: string,
  url: string,
  init?: { method?: string; body?: unknown },
): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  try {
    const res = await fetch(url, {
      method: init?.method ?? "GET",
      headers: { "Content-Type": "application/json", "x-admin-secret": secret },
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
    const parsed: unknown = await res.json().catch(() => ({}));
    const data = (parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {}) as T & { error?: string };
    if (!res.ok && !data.error) data.error = `অনুরোধ ব্যর্থ হয়েছে (${res.status})`;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return {
      ok: false,
      status: 0,
      data: { error: "সার্ভারের সঙ্গে সংযোগ করা যায়নি। আবার চেষ্টা করুন।" } as T & { error?: string },
    };
  }
}
