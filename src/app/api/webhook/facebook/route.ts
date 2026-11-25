import { after } from "next/server";
import { facebookConfig } from "@/config/facebook.config";
import { runAgent } from "@/lib/ai/agent";
import { sendAction, sendHumanLike } from "@/lib/facebook/graph";
import { safeEqual, verifyFacebookSignature } from "@/lib/facebook/signature";
import {
  isProductionWebhookConfigSafe,
  isFacebookEventCountSafe,
  isFacebookWebhookPayloadShape,
  MAX_FACEBOOK_WEBHOOK_BODY_BYTES,
  readBoundedRequestBody,
} from "@/lib/facebook/webhook-safety";
import { getRepo } from "@/lib/repo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Vercel Hobby allows up to 60s. The HTTP response itself returns in milliseconds.
export const maxDuration = 60;

interface MessagingEvent {
  sender?: { id?: string };
  recipient?: { id?: string };
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    attachments?: unknown[];
  };
  postback?: { mid?: string; title?: string; payload?: string };
}

interface WebhookBody {
  object?: string;
  entry?: { id?: string; messaging?: MessagingEvent[] }[];
}

interface Job {
  pageId: string;
  psid: string;
  text: string;
  mid: string | null;
}

/** GET: Facebook webhook verification handshake. */
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const token = facebookConfig.verifyToken;
  if (
    p.get("hub.mode") === "subscribe" &&
    token &&
    safeEqual(p.get("hub.verify_token") ?? "", token) &&
    p.get("hub.challenge")
  ) {
    return new Response(p.get("hub.challenge"), { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new Response("Forbidden", { status: 403 });
}

function extractJobs(body: WebhookBody): Job[] {
  const jobs: Job[] = [];
  for (const entry of body.entry ?? []) {
    const pageId = entry.id;
    if (!pageId) continue;
    for (const ev of entry.messaging ?? []) {
      const psid = ev.sender?.id;
      if (!psid || psid === pageId) continue;
      if (ev.message?.is_echo) continue; // our own outgoing message
      let text = ev.message?.text?.trim();
      let mid = ev.message?.mid ?? null;
      if (!text && ev.message?.attachments?.length) text = "(কাস্টমার একটি ছবি/ফাইল পাঠিয়েছেন)";
      if (!text && ev.postback) {
        text = ev.postback.title || ev.postback.payload || "হ্যালো";
        mid = ev.postback.mid ?? null;
      }
      if (text) jobs.push({ pageId, psid, text, mid });
    }
  }
  return jobs;
}

async function resolveToken(pageId: string): Promise<string | null> {
  const repo = await getRepo();
  const page = await repo.getPage(pageId);
  if (page?.page_access_token) return page.page_access_token;
  // Single-tenant fallback: ONLY for the env-configured page (never reuse its token for other pages).
  if (facebookConfig.pageAccessToken && facebookConfig.pageId === pageId) {
    return facebookConfig.pageAccessToken;
  }
  return null;
}

async function handleJob(job: Job): Promise<void> {
  try {
    const token = await resolveToken(job.pageId);
    if (!token) {
      console.error(`[webhook] no access token / unknown page ${job.pageId} – ignored`);
      return;
    }
    const { messaging } = facebookConfig;
    if (messaging.markSeen) void sendAction(token, job.psid, "mark_seen");
    if (messaging.typingIndicator) void sendAction(token, job.psid, "typing_on");

    const result = await runAgent({
      pageId: job.pageId,
      psid: job.psid,
      text: job.text,
      fbMid: job.mid,
    });
    if (!result) return; // duplicate / inactive page

    await sendHumanLike(token, job.psid, result.reply);
    await result.finalize(); // memory/stage/psych update AFTER the customer already got the reply
  } catch (e) {
    console.error("[webhook] job failed:", e instanceof Error ? e.message : e);
  }
}

/** Processes jobs: same customer sequentially (keeps order), different customers in parallel. */
async function processJobs(jobs: Job[]): Promise<void> {
  const byCustomer = new Map<string, Job[]>();
  for (const j of jobs) {
    const key = `${j.pageId}:${j.psid}`;
    byCustomer.set(key, [...(byCustomer.get(key) ?? []), j]);
  }
  const customers = [...byCustomer.values()];
  const maxConcurrentCustomers = 4;
  for (let i = 0; i < customers.length; i += maxConcurrentCustomers) {
    await Promise.allSettled(
      customers.slice(i, i + maxConcurrentCustomers).map(async (list) => {
        for (const j of list) await handleJob(j);
      }),
    );
  }
}

/** POST: respond 200 immediately, do the heavy AI work in after(). */
export async function POST(req: Request) {
  if (!isProductionWebhookConfigSafe(process.env.NODE_ENV, facebookConfig.verifySignature, facebookConfig.appSecret)) {
    return new Response("Webhook signature verification must be enabled in production", { status: 503 });
  }

  const raw = await readBoundedRequestBody(req, MAX_FACEBOOK_WEBHOOK_BODY_BYTES);
  if (raw === null) return new Response("Payload too large", { status: 413 });

  if (facebookConfig.verifySignature) {
    const ok = verifyFacebookSignature(raw, req.headers.get("x-hub-signature-256"), facebookConfig.appSecret);
    if (!ok) return new Response("Invalid signature", { status: 401 });
  }

  let body: WebhookBody;
  try {
    body = JSON.parse(raw) as WebhookBody;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  if (!isFacebookWebhookPayloadShape(body)) return new Response("Bad Request", { status: 400 });
  if (body.object !== "page") return new Response("Not Found", { status: 404 });
  const eventCount = (body.entry ?? []).reduce((sum, entry) => sum + (entry.messaging?.length ?? 0), 0);
  if (!isFacebookEventCountSafe(eventCount)) return new Response("Too many webhook events", { status: 413 });

  const jobs = extractJobs(body);
  if (jobs.length > 0) after(() => processJobs(jobs));

  return new Response("EVENT_RECEIVED", { status: 200 });
}
