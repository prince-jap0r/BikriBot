import { facebookConfig, graphUrl } from "@/config/facebook.config";
import { splitReply, typingDelayMs } from "./splitter";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function callSendApi(token: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(graphUrl("me/messages"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Token goes in a header (not the URL) so it never lands in access logs.
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: { message?: string; code?: number } } | null;
      console.error(`[facebook] send API ${res.status}: ${err?.error?.code ?? ""} ${err?.error?.message ?? ""}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[facebook] send API failed:", e instanceof Error ? e.message : e);
    return false;
  }
}

export type SenderAction = "typing_on" | "typing_off" | "mark_seen";

export function sendAction(token: string, psid: string, action: SenderAction): Promise<boolean> {
  return callSendApi(token, { recipient: { id: psid }, sender_action: action });
}

export function sendText(token: string, psid: string, text: string): Promise<boolean> {
  return callSendApi(token, {
    recipient: { id: psid },
    messaging_type: "RESPONSE",
    message: { text },
  });
}

/** Splits the reply into short bubbles and sends them with a human-like typing delay. */
export async function sendHumanLike(token: string, psid: string, reply: string): Promise<void> {
  const { messaging } = facebookConfig;
  const bubbles = splitReply(reply);
  for (let i = 0; i < bubbles.length; i++) {
    if (messaging.typingIndicator) {
      await sendAction(token, psid, "typing_on");
      await sleep(typingDelayMs(bubbles[i]));
    }
    const ok = await sendText(token, psid, bubbles[i]);
    if (!ok) return; // don't spam the remaining bubbles if the API is rejecting us
  }
}
