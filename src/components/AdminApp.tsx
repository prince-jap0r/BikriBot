"use client";

import { useCallback, useEffect, useState } from "react";
import { apiCall, type Overview } from "./api";
import ChatTester from "./ChatTester";
import { DashboardPanel, ProductsPanel, SetupPanel } from "./Panels";

const TABS = [
  ["chat", "টেস্ট চ্যাট"],
  ["dashboard", "ড্যাশবোর্ড"],
  ["products", "প্রোডাক্ট"],
  ["setup", "সেটআপ"],
] as const;
type Tab = (typeof TABS)[number][0];

export default function AdminApp() {
  const [secret, setSecret] = useState("");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("chat");
  const [pageId, setPageId] = useState("demo");
  const [data, setData] = useState<Overview | null>(null);

  const load = useCallback(
    async (s: string, p: string) => {
      const r = await apiCall<Overview>(s, `/api/admin/overview?pageId=${encodeURIComponent(p)}`);
      if (r.ok) {
        setData(r.data);
        setSecret(s);
        sessionStorage.setItem("bikribot_secret", s);
        setError("");
      } else {
        setData(null);
        setSecret("");
        sessionStorage.removeItem("bikribot_secret");
        setError(r.data.error ?? "লগইন ব্যর্থ");
      }
    },
    [],
  );

  useEffect(() => {
    const saved = sessionStorage.getItem("bikribot_secret");
    if (!saved) return;
    // Deferred so state is not set synchronously inside the effect body (react-hooks/set-state-in-effect).
    const t = setTimeout(() => void load(saved, "demo"), 0);
    return () => clearTimeout(t);
  }, [load]);

  if (!secret || !data) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void load(draft, pageId);
          }}
          className="w-full max-w-sm space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
        >
          <div>
            <h1 className="text-xl font-bold">🤖 BikriBot</h1>
            <p className="text-sm text-slate-500">Facebook Page Sales AI · অ্যাডমিন</p>
          </div>
          <input
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="ADMIN_SECRET"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500"
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button className="w-full rounded-lg bg-blue-600 py-2 text-sm font-medium text-white">প্রবেশ করুন</button>
        </form>
      </main>
    );
  }

  const reload = () => void load(secret, pageId);

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">🤖 BikriBot</h1>
        <div className="flex items-center gap-2">
          <select
            value={pageId}
            onChange={(e) => {
              setPageId(e.target.value);
              void load(secret, e.target.value);
            }}
            className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm"
          >
            {data.pages.map((p) => (
              <option key={p.page_id} value={p.page_id}>
                {p.shop_name} ({p.page_id})
              </option>
            ))}
          </select>
          <button
            onClick={() => {
              sessionStorage.removeItem("bikribot_secret");
              setSecret("");
              setData(null);
            }}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
          >
            লগআউট
          </button>
        </div>
      </header>

      <nav className="flex gap-1 rounded-xl bg-slate-200 p-1 text-sm">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            onClick={() => {
              setTab(id);
              if (id !== "chat") reload();
            }}
            className={`flex-1 rounded-lg px-3 py-1.5 font-medium ${tab === id ? "bg-white shadow-sm" : "text-slate-600"}`}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "chat" && <ChatTester secret={secret} pageId={pageId} />}
      {tab === "dashboard" && <DashboardPanel data={data} secret={secret} reload={reload} />}
      {tab === "products" && <ProductsPanel data={data} secret={secret} reload={reload} />}
      {tab === "setup" && <SetupPanel data={data} secret={secret} reload={reload} />}
    </main>
  );
}
