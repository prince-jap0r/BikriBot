export const MAX_FACEBOOK_WEBHOOK_BODY_BYTES = 1_000_000;
export const MAX_FACEBOOK_WEBHOOK_EVENTS = 50;

/** Reject malformed decoded JSON before route code iterates nested webhook data. */
export function isFacebookWebhookPayloadShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as { entry?: unknown };
  if (body.entry === undefined) return true;
  if (!Array.isArray(body.entry)) return false;
  return body.entry.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const messaging = (entry as { messaging?: unknown }).messaging;
    return messaging === undefined || (Array.isArray(messaging) && messaging.every(
      (event) => !!event && typeof event === "object" && !Array.isArray(event),
    ));
  });
}

export function isFacebookEventCountSafe(eventCount: number): boolean {
  return Number.isSafeInteger(eventCount) && eventCount >= 0 && eventCount <= MAX_FACEBOOK_WEBHOOK_EVENTS;
}

/** Reads a request incrementally and cancels as soon as the byte limit is exceeded. */
export async function readBoundedRequestBody(request: Request, maxBytes: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(body);
}

/** Production webhook requests must never bypass HMAC verification. */
export function isProductionWebhookConfigSafe(
  nodeEnv: string | undefined,
  verifySignature: boolean,
  appSecret: string,
): boolean {
  return nodeEnv !== "production" || (verifySignature && appSecret.length > 0);
}
