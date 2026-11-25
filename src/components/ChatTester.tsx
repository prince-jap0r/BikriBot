"use client";

import { useEffect, useRef, useState } from "react";
import { apiCall } from "./api";

interface Msg {
  role: "user" | "assistant";
  text: string;
  debug?: { stage: string; modules: string[]; tools: string[]; model: string; approxPromptTokens: number };
  error?: string;
}

function newSession(): string {
  return `s${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export default function ChatTester({ secret, pageId }: { secret: string; pageId: string }) {
  const [sessionId, setSessionId] = useState(newSession);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy]);

  async function send() {
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    setMsgs((m) => [...m, { role: "user", text: t }]);
    setBusy(true);
    try {
      const r = await apiCall<{
        reply?: string;
        failed?: boolean;
        error?: string;
        debug?: Msg["debug"];
      }>(secret, "/api/chat", { method: "POST", body: { pageId, sessionId, text: t } });
      if (!r.ok || !r.data.reply) {
        setMsgs((m) => [...m, { role: "assistant", text: "—", error: r.data.error ?? "অজানা সমস্যা" }]);
        return;
      }
      // Show the reply exactly as it would be split into bubbles on Messenger.
      const bubbles = r.data.reply.split("\n").filter(Boolean);
      setMsgs((m) => [
        ...m,
        ...bubbles.map((b, i) => ({
          role: "assistant" as const,
          text: b,
          debug: i === bubbles.length - 1 ? r.data.debug : undefined,
          error: i === 0 && r.data.failed ? r.data.error : undefined,
        })),
      ]);
    } catch {
      setMsgs((m) => [...m, { role: "assistant", text: "—", error: "অনুরোধ ব্যর্থ হয়েছে। আবার চেষ্টা করুন।" }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex h-[70vh] max-w-2xl flex-col rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <div>
          <div className="font-semibold">টেস্ট চ্যাট</div>
          <div className="text-xs text-slate-500">পেজ: {pageId} · ফেসবুক ছাড়াই এজেন্ট পরীক্ষা করুন</div>
        </div>
        <button
          onClick={() => {
            setSessionId(newSession());
            setMsgs([]);
          }}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm hover:bg-slate-50"
        >
          নতুন চ্যাট
        </button>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto bg-slate-50 p-4">
        {msgs.length === 0 && (
          <p className="pt-10 text-center text-sm text-slate-400">
            যেমন লিখুন: &quot;পাঞ্জাবির দাম কত?&quot; বা &quot;দাম একটু বেশি মনে হচ্ছে&quot;
          </p>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div className="max-w-[80%]">
              <div
                className={
                  m.role === "user"
                    ? "rounded-2xl rounded-br-sm bg-blue-600 px-3 py-2 text-sm text-white"
                    : "rounded-2xl rounded-bl-sm bg-white px-3 py-2 text-sm shadow-sm ring-1 ring-slate-200"
                }
              >
                {m.text}
              </div>
              {m.error && <div className="mt-1 text-xs text-red-600">⚠ {m.error}</div>}
              {m.debug && (
                <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-slate-500">
                  <span className="rounded bg-slate-200 px-1.5 py-0.5">ধাপ: {m.debug.stage}</span>
                  <span className="rounded bg-slate-200 px-1.5 py-0.5">~{m.debug.approxPromptTokens} টোকেন</span>
                  <span className="rounded bg-slate-200 px-1.5 py-0.5">মডিউল: {m.debug.modules.join(", ")}</span>
                  {m.debug.tools.length > 0 && (
                    <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700">
                      টুল: {m.debug.tools.join(", ")}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && <div className="text-xs text-slate-400">টাইপ করছে…</div>}
        <div ref={endRef} />
      </div>

      <form
        className="flex gap-2 border-t border-slate-100 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="কাস্টমার হিসেবে মেসেজ লিখুন…"
          maxLength={1500}
          className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500"
        />
        <button
          disabled={busy || !text.trim()}
          className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          পাঠান
        </button>
      </form>
    </div>
  );
}
