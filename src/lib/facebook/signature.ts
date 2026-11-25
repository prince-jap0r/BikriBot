import crypto from "node:crypto";

/** Verifies Facebook's `X-Hub-Signature-256` header against the RAW request body. */
export function verifyFacebookSignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const [scheme, signature] = header.split("=");
  if (scheme !== "sha256" || !signature) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Constant-time string comparison for verify tokens. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
