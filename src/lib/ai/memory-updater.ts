import { generateText } from "ai";
import { z } from "zod";
import { aiConfig } from "@/config/ai.config";
import { getFallbackModel, getPrimaryModel } from "./provider";
import {
  PSYCH_TYPES,
  STAGES,
  type Customer,
  type CustomerPatch,
  type Memory,
  type Repo,
} from "@/lib/repo/types";

const OutputSchema = z.object({
  stage: z.enum(STAGES).optional(),
  psych_type: z.enum(PSYCH_TYPES).optional(),
  summary: z.string().max(600).optional(),
  preferences: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  name: z.string().max(80).nullable().optional(),
});

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

const INSTRUCTION = `তুমি একটি কাস্টমার-প্রোফাইল এক্সট্র্যাক্টর। নিচের তথ্য দেখে শুধু একটি JSON অবজেক্ট দাও, অন্য কিছু নয়।
ফিল্ড:
- stage: ${STAGES.join("|")} (কথোপকথন এখন কোন ধাপে)
- psych_type: ${PSYCH_TYPES.join("|")}
- summary: পুরোনো সারাংশ + নতুন তথ্য মিলিয়ে বাংলায় সর্বোচ্চ ৩০০ অক্ষরের সারাংশ (কী চেয়েছে, আপত্তি, পছন্দ)
- preferences: ছোট key-value (যেমন size, color, budget, interest), শুধু কাস্টমার নিজে যা বলেছে
- name: শুধু কাস্টমার নিজে স্পষ্ট বললে, নইলে null
ফোন নম্বর, পূর্ণ ঠিকানা, কার্ড বা পাসওয়ার্ড কোনো summary/preferences/name-এ রাখবে না।
নিয়ম: অনুমান করে তথ্য বানাবে না। "ordered" ধাপ দেবে না (সিস্টেম নিজে সেট করে)।`;

function redactForMemory(text: string): string {
  return text
    .replace(/(?:\+?880)?0?1[3-9][0-9০-৯]{8}/gu, "[ফোন গোপন]")
    .replace(/(?:ঠিকানা|address|বাসা|বাড়ি|বাড়ি)\s*[=:：-]?\s*[^\n]+/giu, "[অর্ডার ঠিকানা গোপন]");
}

export function sanitizeMemoryForModel(memory: Pick<Memory, "summary" | "preferences"> | null) {
  const preferences: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(memory?.preferences ?? {})) {
    if (/(?:phone|mobile|address|ঠিকানা|ফোন|মোবাইল)/iu.test(key)) continue;
    if (typeof value === "string") preferences[key] = redactForMemory(value);
    else if (Array.isArray(value)) preferences[key] = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => redactForMemory(item));
  }
  return {
    summary: redactForMemory(memory?.summary ?? ""),
    preferences,
  };
}

export interface MemoryUpdateInput {
  repo: Repo;
  pageId: string;
  customer: Customer;
  userText: string;
  reply: string;
  /** True when createOrder succeeded this turn (stage is already handled deterministically). */
  orderPlaced: boolean;
}

/**
 * Runs AFTER the reply has been delivered. Cheap, small-context extraction call that keeps
 * stage / psych_type / summary / preferences fresh. Never throws.
 */
export async function updateMemoryAfterTurn(input: MemoryUpdateInput): Promise<void> {
  const { repo, pageId, customer, userText, reply, orderPlaced } = input;
  try {
    const fresh = (await repo.getMemory(customer.id)) as Memory | null;
    const safeMemory = sanitizeMemoryForModel(fresh);
    const prompt = [
      `বর্তমান ধাপ: ${customer.stage}`,
      `বর্তমান ধরন: ${customer.psych_type}`,
      `পুরোনো সারাংশ: ${safeMemory.summary || "(নেই)"}`,
      `পুরোনো পছন্দ: ${JSON.stringify(safeMemory.preferences)}`,
      `কাস্টমার: ${redactForMemory(userText).slice(0, 500)}`,
      `আমাদের উত্তর: ${redactForMemory(reply).slice(0, 500)}`,
    ].join("\n");

    const call = async (model: ReturnType<typeof getPrimaryModel>) =>
      generateText({
        model,
        system: INSTRUCTION,
        prompt,
        temperature: 0,
        maxOutputTokens: 350,
        abortSignal: AbortSignal.timeout(Math.min(aiConfig.timeoutMs, 20000)),
      });

    let text: string;
    try {
      text = (await call(getPrimaryModel())).text;
    } catch (e) {
      const fb = getFallbackModel();
      if (!fb) throw e;
      text = (await call(fb)).text;
    }

    const parsed = OutputSchema.safeParse(extractJson(text));
    if (!parsed.success) return;
    const out = parsed.data;

    // ── Customer patch (guarded) ──
    const patch: CustomerPatch = {};
    if (!orderPlaced && out.stage && out.stage !== "ordered" && out.stage !== customer.stage) {
      patch.stage = out.stage;
    }
    if (out.psych_type && out.psych_type !== "unknown" && out.psych_type !== customer.psych_type) {
      patch.psych_type = out.psych_type;
    }
    if (out.name && out.name.trim().length >= 2 && !customer.name) patch.name = out.name.trim();
    if (Object.keys(patch).length) await repo.updateCustomer(customer.id, patch);

    // ── Memory merge (re-read: createOrder may have just written last_order_summary etc.) ──
    const current = await repo.getMemory(customer.id);
    const prefs: Record<string, unknown> = { ...(current?.preferences ?? {}) };
    Object.assign(prefs, out.preferences ?? {});
    const safeUpdatedMemory = sanitizeMemoryForModel({
      summary: out.summary ?? current?.summary ?? "",
      preferences: prefs,
    });
    const safePrefs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(safeUpdatedMemory.preferences).slice(0, 10)) {
      safePrefs[k.slice(0, 30)] = Array.isArray(v)
        ? v.slice(0, 5).map((x) => x.slice(0, 60))
        : v.slice(0, 100);
    }
    await repo.upsertMemory({
      customer_id: customer.id,
      page_id: pageId,
      summary: safeUpdatedMemory.summary.slice(0, 600),
      preferences: safePrefs,
      last_address: current?.last_address ?? null,
      last_order_summary: current?.last_order_summary ?? null,
      total_orders: current?.total_orders ?? 0,
    });
  } catch (e) {
    console.error("[memory-updater] skipped:", e instanceof Error ? e.message : e);
  }
}
