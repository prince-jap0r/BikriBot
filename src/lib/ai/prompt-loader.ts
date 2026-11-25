import fs from "node:fs";
import path from "node:path";
import type { Customer, Memory, PageRow, Stage } from "@/lib/repo/types";

/**
 * Dynamic, stage-aware prompt assembly.
 * Goal: send the fewest input tokens possible for each customer turn.
 *
 *  core.md   → always
 *  flow.md   → whole file; if it ever gains `## [all]` / `## [stage:xxx]` sections,
 *              only intro + [all] + the current stage section are sent
 *  psych.md  → only for product/objection/closing stages (or objection-like text);
 *              whole file, or intro + [all] + the customer's `## [psych:xxx]` section if present
 *  db.md     → only when product/price/stock/order intent is present (not on a pure greeting)
 *  memory.md → only for returning customers (or ordered/after_sales stages).
 *              The "## State template" part is NOT sent: memory is maintained by
 *              memory-updater.ts, and showing the JSON template to the chat model
 *              risks it leaking state JSON into customer replies.
 */

type Sections = { intro: string; map: Map<string, string> };

const fileCache = new Map<string, Sections>();

/**
 * Prompt files live in ./prompts (a copy at the repo root also works).
 * They are bundled for serverless via `outputFileTracingIncludes` in next.config.ts,
 * so the dynamic path below is intentionally excluded from Turbopack's static tracing.
 */
function readPromptFile(name: string): string {
  const root = process.cwd();
  const candidates = [
    path.join(/*turbopackIgnore: true*/ root, "prompts", name),
    path.join(/*turbopackIgnore: true*/ root, name),
  ];
  for (const p of candidates) {
    if (fs.existsSync(/*turbopackIgnore: true*/ p)) return fs.readFileSync(/*turbopackIgnore: true*/ p, "utf8");
  }
  throw new Error(`Prompt file not found: ${name} (looked in prompts/ and project root)`);
}

/** Splits markdown by headers of the form `## [key]`. Text before the first key is the intro. */
function parseSections(md: string): Sections {
  const map = new Map<string, string>();
  const intro: string[] = [];
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current) map.set(current, buf.join("\n").trim());
    buf = [];
  };
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^##\s*\[([^\]]+)\]\s*$/);
    if (m) {
      flush();
      current = m[1].trim();
    } else if (current) {
      buf.push(line);
    } else {
      intro.push(line);
    }
  }
  flush();
  return { intro: intro.join("\n").trim(), map };
}

function load(name: string): Sections {
  let s = fileCache.get(name);
  if (!s) {
    s = parseSections(readPromptFile(name));
    fileCache.set(name, s);
  }
  return s;
}

const rawCache = new Map<string, string>();
function raw(name: string): string {
  let t = rawCache.get(name);
  if (t === undefined) {
    t = readPromptFile(name).trim();
    rawCache.set(name, t);
  }
  return t;
}

// ───────── Intent heuristics (Bangla + English + Banglish) ─────────
const PRODUCT_INTENT =
  /(দাম|দর|কত|প্রাইজ|price|rate|stock|স্টক|আছে|available|কিনব|কিনতে|নিব|নেব|অর্ডার|order|ডেলিভারি|delivery|সাইজ|size|কালার|color|রঙ|ছবি|pic|দেখান|দেখাও|কালেকশন|পাঞ্জাবি|শাড়ি|জুতা|শার্ট)/i;
const OBJECTION_INTENT =
  /(বেশি|কমান|কমাও|ছাড়|discount|ডিসকাউন্ট|দাম কম|ভরসা|বিশ্বাস|ফেক|নকল|আসল|ঠিক আছে কিনা|পরে|ভেবে|ভাবি|লাগবে না|লাগব না|expensive|costly|later|trust|fake|ফেরত|রিটার্ন)/i;

export interface PromptContext {
  page: Pick<PageRow, "shop_name" | "agent_name" | "shop_info">;
  customer: Pick<Customer, "name" | "phone" | "stage" | "psych_type">;
  memory: Memory | null;
  userText: string;
}

export interface BuiltPrompt {
  system: string;
  modules: string[];
  effectiveStage: Stage;
  approxTokens: number;
}

export function effectiveStageFor(stage: Stage, userText: string): Stage {
  const objection = OBJECTION_INTENT.test(userText);
  const product = PRODUCT_INTENT.test(userText);
  switch (stage) {
    case "greeting":
      return product ? "product" : "greeting";
    case "discovery":
      return objection ? "objection" : product ? "product" : "discovery";
    case "product":
      return objection ? "objection" : "product";
    default:
      return stage;
  }
}

let memoryRulesCache: string | undefined;
/** memory.md without its "## State template" appendix (see header comment). */
function memoryRules(): string {
  if (memoryRulesCache === undefined) {
    const full = raw("memory.md");
    const cut = full.search(/^##\s*State template/im);
    memoryRulesCache = (cut >= 0 ? full.slice(0, cut) : full).trim();
  }
  return memoryRulesCache;
}

function fill(text: string, ctx: PromptContext): string {
  return text
    .replaceAll("{{agent_name}}", ctx.page.agent_name)
    .replaceAll("{{shop_name}}", ctx.page.shop_name);
}

function redactMemoryPii(text: string): string {
  return text
    .replace(/(?:\+?880)?0?1[3-9][0-9০-৯]{8}/gu, "[ফোন গোপন]")
    .replace(/(?:ঠিকানা|address|বাসা|বাড়ি|বাড়ি)\s*[:：-]?\s*[^\n;|]+/giu, "[অর্ডার ঠিকানা গোপন]");
}

function memoryBlock(memory: Memory | null): string {
  if (!memory) return "";
  const parts: string[] = [];
  if (memory.summary) parts.push(`সারাংশ: ${redactMemoryPii(memory.summary)}`);
  const prefs = Object.entries(memory.preferences ?? {})
    .filter(([k, v]) =>
      !/(?:phone|mobile|address|ঠিকানা|ফোন|মোবাইল)/iu.test(k) &&
      v !== null && v !== "" && !(Array.isArray(v) && v.length === 0),
    )
    .map(([k, v]) => `${k}: ${redactMemoryPii(Array.isArray(v) ? v.join(", ") : String(v))}`);
  if (prefs.length) parts.push(`পছন্দ: ${prefs.join("; ")}`);
  if (memory.last_order_summary) parts.push(`শেষ অর্ডার: ${redactMemoryPii(memory.last_order_summary)}`);
  if (memory.total_orders > 0) parts.push(`মোট অর্ডার: ${memory.total_orders}`);
  return parts.join("\n");
}

export function isReturning(memory: Memory | null): boolean {
  return !!memory && (memory.total_orders > 0 || memory.summary.trim().length > 0);
}

export function buildSystemPrompt(ctx: PromptContext): BuiltPrompt {
  const modules: string[] = [];
  const blocks: string[] = [];
  const stage = effectiveStageFor(ctx.customer.stage, ctx.userText);

  // 1) core – always
  blocks.push(fill(raw("core.md"), ctx));
  modules.push("core");

  // 2) flow – current stage only
  const flow = load("flow.md");
  const flowParts = [flow.intro, flow.map.get("all"), flow.map.get(`stage:${stage}`)].filter(Boolean);
  blocks.push(fill(flowParts.join("\n\n"), ctx));
  modules.push(`flow:${stage}`);

  // 3) psych – only when it matters, and only the relevant psych_type section
  const needsPsych =
    stage === "product" || stage === "objection" || stage === "closing" || OBJECTION_INTENT.test(ctx.userText);
  if (needsPsych) {
    const psych = load("psych.md");
    const key = `psych:${ctx.customer.psych_type}`;
    const fallbackKey = psych.map.has("psych:unknown") ? "psych:unknown" : null;
    const usedKey = psych.map.has(key) ? key : fallbackKey;
    const parts = [psych.intro, psych.map.get("all"), usedKey ? psych.map.get(usedKey) : undefined].filter(Boolean);
    blocks.push(parts.join("\n\n"));
    modules.push(usedKey ?? "psych");
  }

  // 4) db – only when product/price/order intent
  const needsDb = stage !== "greeting" || PRODUCT_INTENT.test(ctx.userText);
  if (needsDb) {
    blocks.push(raw("db.md"));
    modules.push("db");
  }

  // 5) memory – only for returning customers or post-order stages
  const returning = isReturning(ctx.memory);
  if (returning || stage === "ordered" || stage === "after_sales") {
    blocks.push(memoryRules());
    modules.push("memory");
  }

  // 6) dynamic context (compact)
  const ctxLines: string[] = [
    "## বর্তমান তথ্য",
    // core.md no longer carries {{agent_name}}/{{shop_name}}, so the identity is injected here.
    `শপ: ${ctx.page.shop_name} | তোমার নাম: ${ctx.page.agent_name}`,
    `আজকের তারিখ: ${new Date().toLocaleDateString("bn-BD", { timeZone: "Asia/Dhaka", dateStyle: "long" })}`,
    `ধাপ: ${stage} | কাস্টমারের ধরন: ${ctx.customer.psych_type}`,
    `কাস্টমার: ${ctx.customer.name ?? "(নাম জানা নেই)"}`,
  ];
  if (ctx.page.shop_info.trim()) ctxLines.push(`শপ তথ্য: ${ctx.page.shop_info.trim()}`);
  const mem = memoryBlock(ctx.memory);
  if (mem) ctxLines.push("## কাস্টমার মেমরি", mem);
  blocks.push(ctxLines.join("\n"));

  const system = blocks.join("\n\n");
  return {
    system,
    modules,
    effectiveStage: stage,
    // Rough estimate: Bangla ≈ 1 token / 2.2 chars
    approxTokens: Math.round(system.length / 2.2),
  };
}
