import { facebookConfig, type FacebookConfig } from "@/config/facebook.config";

const FB_HARD_LIMIT = 1900; // Messenger text limit is 2000 chars

function splitLongLine(line: string, max: number): string[] {
  if (line.length <= max) return [line];
  const sentences = line.match(/[^।.!?]+[।.!?]*\s*/g) ?? [line];
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if ((buf + s).length > max && buf) {
      out.push(buf.trim());
      buf = "";
    }
    if (s.length > max) {
      // Extremely long sentence: split on words.
      for (const w of s.split(/\s+/)) {
        if ((buf + " " + w).trim().length > max && buf) {
          out.push(buf.trim());
          buf = "";
        }
        buf = (buf + " " + w).trim();
      }
    } else {
      buf += s;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/**
 * Splits a reply into short, human-looking Messenger bubbles.
 * Limits: lines/bubble, chars/bubble and total bubbles come from facebook.config.
 */
export function splitReply(text: string, cfg: FacebookConfig = facebookConfig): string[] {
  const { maxChunkChars, maxLinesPerBubble, maxBubbles } = cfg.messaging;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((l) => splitLongLine(l, maxChunkChars));

  const bubbles: string[] = [];
  let cur: string[] = [];
  for (const line of lines) {
    const joined = [...cur, line].join("\n");
    if (cur.length > 0 && (cur.length >= maxLinesPerBubble || joined.length > maxChunkChars)) {
      bubbles.push(cur.join("\n"));
      cur = [];
    }
    cur.push(line);
  }
  if (cur.length) bubbles.push(cur.join("\n"));

  // Never exceed maxBubbles: fold the overflow into the last allowed bubble.
  if (bubbles.length > maxBubbles) {
    const head = bubbles.slice(0, maxBubbles - 1);
    const tail = bubbles.slice(maxBubbles - 1).join("\n");
    return [...head, tail].map((b) => b.slice(0, FB_HARD_LIMIT));
  }
  return bubbles.map((b) => b.slice(0, FB_HARD_LIMIT));
}

/** Simulated typing time for a bubble (base + perChar, capped). */
export function typingDelayMs(text: string, cfg: FacebookConfig = facebookConfig): number {
  const { typingDelayBaseMs, typingDelayPerCharMs, maxTypingDelayMs } = cfg.messaging;
  return Math.min(maxTypingDelayMs, typingDelayBaseMs + typingDelayPerCharMs * text.length);
}
