"use client";

import { useState } from "react";
import type { Overview } from "./api";
import { apiCall } from "./api";
import type { Product } from "@/lib/repo/types";

const STATUSES = ["pending", "confirmed", "shipped", "delivered", "cancelled"] as const;
const STATUS_BN: Record<string, string> = {
  pending: "অপেক্ষমাণ",
  confirmed: "কনফার্মড",
  shipped: "শিপড",
  delivered: "ডেলিভারড",
  cancelled: "বাতিল",
};

const card = "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm";
const input = "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500";

export function DashboardPanel({
  data,
  secret,
  reload,
}: {
  data: Overview;
  secret: string;
  reload: () => void;
}) {
  const s = data.stats;
  const [statusMsg, setStatusMsg] = useState("");
  const cards = [
    ["কাস্টমার", s.customers],
    ["মেসেজ", s.messages],
    ["অর্ডার", s.orders],
    ["আয় (৳)", s.revenue],
    ["প্রোডাক্ট", s.products],
  ] as const;

  async function setStatus(orderId: string, status: string) {
    const r = await apiCall(secret, "/api/admin/orders", { method: "PATCH", body: { pageId: data.pageId, orderId, status } });
    if (!r.ok) {
      setStatusMsg(r.data.error ?? "স্ট্যাটাস আপডেট হয়নি");
      return;
    }
    setStatusMsg("স্ট্যাটাস আপডেট হয়েছে");
    reload();
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {cards.map(([label, v]) => (
          <div key={label} className={card}>
            <div className="text-xs text-slate-500">{label}</div>
            <div className="text-2xl font-bold">{v}</div>
          </div>
        ))}
      </div>

      <div className={card}>
        <h3 className="mb-3 font-semibold">সাম্প্রতিক অর্ডার</h3>
        {statusMsg && <p role="status" className="mb-2 text-sm text-slate-600">{statusMsg}</p>}
        {data.orders.length === 0 ? (
          <p className="text-sm text-slate-400">এখনো কোনো অর্ডার নেই।</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-slate-500">
                <tr>
                  <th className="py-2 pr-3">অর্ডার</th>
                  <th className="pr-3">কাস্টমার</th>
                  <th className="pr-3">আইটেম</th>
                  <th className="pr-3">মোট</th>
                  <th>স্ট্যাটাস</th>
                </tr>
              </thead>
              <tbody>
                {data.orders.map((o) => (
                  <tr key={o.id} className="border-t border-slate-100 align-top">
                    <td className="py-2 pr-3 font-mono text-xs">{o.order_no}</td>
                    <td className="pr-3">
                      <div>{o.customer_name}</div>
                      <div className="text-xs text-slate-500">{o.phone}</div>
                      <div className="max-w-[220px] text-xs text-slate-500">{o.address}</div>
                    </td>
                    <td className="pr-3 text-xs">{o.items.map((i) => `${i.name} ×${i.qty}`).join(", ")}</td>
                    <td className="pr-3">
                      {o.total}৳
                      <div className="text-xs text-slate-500">ডেলিভারি {o.delivery_charge}৳</div>
                    </td>
                    <td>
                      <select
                        value={o.status}
                        onChange={(e) => void setStatus(o.id, e.target.value)}
                        className="rounded border border-slate-200 px-2 py-1 text-xs"
                      >
                        {STATUSES.map((st) => (
                          <option key={st} value={st}>
                            {STATUS_BN[st]}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className={card}>
        <h3 className="mb-3 font-semibold">সাম্প্রতিক কাস্টমার</h3>
        {data.customers.length === 0 ? (
          <p className="text-sm text-slate-400">কোনো কাস্টমার নেই।</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {data.customers.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {c.name ?? "(নাম নেই)"} <span className="text-xs text-slate-400">{c.psid.slice(0, 14)}</span>
                </span>
                <span className="flex gap-1 text-[11px]">
                  <span className="rounded bg-blue-50 px-2 py-0.5 text-blue-700">{c.stage}</span>
                  <span className="rounded bg-amber-50 px-2 py-0.5 text-amber-700">{c.psych_type}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const emptyForm = { id: "", sku: "", name: "", description: "", category: "", price: "0", stock: "0", is_active: true };

export function ProductsPanel({
  data,
  secret,
  reload,
}: {
  data: Overview;
  secret: string;
  reload: () => void;
}) {
  const [form, setForm] = useState(emptyForm);
  const [msg, setMsg] = useState("");

  function edit(p: Product) {
    setForm({
      id: p.id,
      sku: p.sku ?? "",
      name: p.name,
      description: p.description,
      category: p.category,
      price: String(p.price),
      stock: String(p.stock),
      is_active: p.is_active,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const r = await apiCall<{ ok?: boolean }>(secret, "/api/admin/products", {
      method: "POST",
      body: {
        pageId: data.pageId,
        product: {
          ...(form.id ? { id: form.id } : {}),
          sku: form.sku.trim() || null,
          name: form.name.trim(),
          description: form.description,
          category: form.category,
          price: Number(form.price),
          stock: Number(form.stock),
          is_active: form.is_active,
        },
      },
    });
    setMsg(r.ok ? "সেভ হয়েছে ✓" : (r.data.error ?? "সেভ হয়নি"));
    if (r.ok) {
      setForm(emptyForm);
      reload();
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={save} className={`${card} grid gap-3 sm:grid-cols-2`}>
        <h3 className="font-semibold sm:col-span-2">{form.id ? "প্রোডাক্ট এডিট" : "নতুন প্রোডাক্ট"}</h3>
        <input className={input} placeholder="নাম *" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input className={input} placeholder="SKU (ঐচ্ছিক)" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} />
        <input className={input} placeholder="ক্যাটাগরি" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
        <input className={input} placeholder="বিবরণ (সাইজ/কালার ইত্যাদি)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <input className={input} type="number" min={0} placeholder="দাম (৳)" required value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
        <input className={input} type="number" min={0} placeholder="স্টক" required value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
          সক্রিয় (এজেন্ট বিক্রি করবে)
        </label>
        <div className="flex items-center gap-3 sm:justify-end">
          <span className="text-sm text-slate-500">{msg}</span>
          {form.id && (
            <button type="button" onClick={() => setForm(emptyForm)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
              বাতিল
            </button>
          )}
          <button className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white">সেভ</button>
        </div>
      </form>

      <div className={card}>
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-slate-500">
            <tr>
              <th className="py-2">প্রোডাক্ট</th>
              <th>দাম</th>
              <th>স্টক</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.products.map((p) => (
              <tr key={p.id} className={`border-t border-slate-100 ${p.is_active ? "" : "opacity-50"}`}>
                <td className="py-2">
                  {p.name}
                  <div className="text-xs text-slate-500">
                    {p.sku} {p.category && `· ${p.category}`}
                  </div>
                </td>
                <td>{p.price}৳</td>
                <td className={p.stock === 0 ? "text-red-600" : ""}>{p.stock}</td>
                <td className="text-right">
                  <button onClick={() => edit(p)} className="text-xs text-blue-600 hover:underline">
                    এডিট
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Check({ ok, label, hint }: { ok: boolean; label: string; hint?: string }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <span className={ok ? "text-emerald-600" : "text-red-500"}>{ok ? "✔" : "✘"}</span>
      <span>
        {label}
        {!ok && hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </span>
    </li>
  );
}

export function SetupPanel({
  data,
  secret,
  reload,
}: {
  data: Overview;
  secret: string;
  reload: () => void;
}) {
  const s = data.setup;
  const [form, setForm] = useState({
    page_id: "",
    shop_name: "",
    agent_name: "",
    shop_info: "",
    page_access_token: "",
  });
  const [msg, setMsg] = useState("");
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const body = Object.fromEntries(Object.entries(form).filter(([, v]) => v.trim() !== ""));
    const r = await apiCall<{ ok?: boolean }>(secret, "/api/admin/pages", { method: "POST", body });
    setMsg(r.ok ? "পেজ সেভ হয়েছে ✓" : (r.data.error ?? "সেভ হয়নি"));
    if (r.ok) {
      setForm({ page_id: "", shop_name: "", agent_name: "", shop_info: "", page_access_token: "" });
      reload();
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className={card}>
        <h3 className="mb-3 font-semibold">সিস্টেম স্ট্যাটাস</h3>
        <ul className="space-y-2">
          <Check ok label={`ডাটাবেস: ${s.dbDriver}`} />
          <Check ok={s.aiKeySet} label={`AI: ${s.aiProvider} · ${s.defaultModel} (fallback: ${s.fallbackModel})`} hint="OPENROUTER_API_KEY সেট করুন" />
          <Check ok={s.fbVerifyTokenSet} label="FB_VERIFY_TOKEN" hint="ওয়েবহুক ভেরিফিকেশনের জন্য দরকার" />
          <Check ok={s.fbAppSecretSet} label="FB_APP_SECRET (সিগনেচার যাচাই)" hint="প্রোডাকশনে বাধ্যতামূলক" />
          <Check ok={s.fbPageTokenSet} label="FB_PAGE_ACCESS_TOKEN (সিঙ্গেল-পেজ মোড)" hint="অথবা নিচের ফর্মে প্রতিটি পেজের টোকেন দিন" />
          <Check ok={s.signatureVerification} label="Signature verification চালু" hint="FB_VERIFY_SIGNATURE=true রাখুন" />
        </ul>
        <div className="mt-4 rounded-lg bg-slate-50 p-3 text-xs">
          <div className="font-semibold">Webhook Callback URL</div>
          <code className="break-all">{origin}{s.webhookPath}</code>
          <div className="mt-2 text-slate-500">
            Meta App → Messenger → Webhooks-এ এই URL ও আপনার Verify Token দিন। Subscribe: messages, messaging_postbacks।
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <form onSubmit={save} className={`${card} grid gap-3`}>
          <h3 className="font-semibold">পেজ (টেন্যান্ট) যোগ / আপডেট</h3>
          <input className={input} placeholder="Facebook Page ID *" required value={form.page_id} onChange={(e) => setForm({ ...form, page_id: e.target.value })} />
          <input className={input} placeholder="শপের নাম" value={form.shop_name} onChange={(e) => setForm({ ...form, shop_name: e.target.value })} />
          <input className={input} placeholder="এজেন্টের নাম (যেমন রাহি)" value={form.agent_name} onChange={(e) => setForm({ ...form, agent_name: e.target.value })} />
          <textarea className={input} rows={3} placeholder="শপ তথ্য: পেমেন্ট, রিটার্ন পলিসি ইত্যাদি" value={form.shop_info} onChange={(e) => setForm({ ...form, shop_info: e.target.value })} />
          <input className={input} type="password" autoComplete="off" placeholder="Page Access Token (লেখা যাবে, দেখা যাবে না)" value={form.page_access_token} onChange={(e) => setForm({ ...form, page_access_token: e.target.value })} />
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-500">{msg}</span>
            <button className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white">সেভ</button>
          </div>
        </form>

        <div className={card}>
          <h3 className="mb-2 font-semibold">রেজিস্টার্ড পেজ</h3>
          <ul className="space-y-1 text-sm">
            {data.pages.map((p) => (
              <li key={p.page_id} className="flex justify-between">
                <span>
                  {p.shop_name} <span className="text-xs text-slate-400">({p.page_id})</span>
                </span>
                <span className={p.has_token ? "text-emerald-600" : "text-slate-400"}>
                  {p.has_token ? "টোকেন আছে" : "টোকেন নেই"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
