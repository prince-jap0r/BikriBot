/**
 * Facebook / Messenger configuration.
 * Everything is resolved from environment variables (.env / Vercel Project Settings).
 * No secrets are hard-coded here.
 */

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) ? n : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export interface FacebookConfig {
  /** Default (single-tenant) Page ID. Multi-tenant pages live in the `pages` table. */
  pageId: string;
  /** Default Page Access Token. Per-tenant tokens in the `pages` table override this. */
  pageAccessToken: string;
  /** Token used for the GET webhook verification handshake. */
  verifyToken: string;
  /** App Secret used to verify X-Hub-Signature-256. */
  appSecret: string;
  graphApiVersion: string;
  graphBaseUrl: string;
  /** If false, signature verification is skipped (ONLY for local testing). */
  verifySignature: boolean;
  messaging: {
    /** Max characters per outgoing Messenger bubble (FB hard limit is 2000). */
    maxChunkChars: number;
    /** Max lines per bubble before a new bubble is started. */
    maxLinesPerBubble: number;
    /** Max bubbles per reply (keeps the chat human and short). */
    maxBubbles: number;
    /** Show the typing_on indicator while the agent is thinking / typing. */
    typingIndicator: boolean;
    /** Simulated typing delay = base + perChar * length (capped by maxTypingDelayMs). */
    typingDelayBaseMs: number;
    typingDelayPerCharMs: number;
    maxTypingDelayMs: number;
    /** Mark incoming message as seen. */
    markSeen: boolean;
  };
}

export function getFacebookConfig(): FacebookConfig {
  const env = process.env;
  const version = env.FB_GRAPH_API_VERSION || "v21.0";
  return {
    pageId: env.FB_PAGE_ID || "",
    pageAccessToken: env.FB_PAGE_ACCESS_TOKEN || "",
    verifyToken: env.FB_VERIFY_TOKEN || "",
    appSecret: env.FB_APP_SECRET || "",
    graphApiVersion: version,
    graphBaseUrl: env.FB_GRAPH_BASE_URL || "https://graph.facebook.com",
    verifySignature: bool(env.FB_VERIFY_SIGNATURE, true),
    messaging: {
      maxChunkChars: num(env.FB_MAX_CHUNK_CHARS, 280),
      maxLinesPerBubble: num(env.FB_MAX_LINES_PER_BUBBLE, 2),
      maxBubbles: num(env.FB_MAX_BUBBLES, 3),
      typingIndicator: bool(env.FB_TYPING_INDICATOR, true),
      typingDelayBaseMs: num(env.FB_TYPING_DELAY_BASE_MS, 400),
      typingDelayPerCharMs: num(env.FB_TYPING_DELAY_PER_CHAR_MS, 25),
      maxTypingDelayMs: num(env.FB_MAX_TYPING_DELAY_MS, 2200),
      markSeen: bool(env.FB_MARK_SEEN, true),
    },
  };
}

/** Convenience snapshot (read at module load on the server). */
export const facebookConfig: FacebookConfig = getFacebookConfig();

export function graphUrl(path: string, cfg: FacebookConfig = facebookConfig): string {
  return `${cfg.graphBaseUrl}/${cfg.graphApiVersion}/${path.replace(/^\//, "")}`;
}
