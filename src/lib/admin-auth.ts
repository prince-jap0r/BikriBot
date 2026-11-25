import { appConfig } from "@/config/app.config";
import { safeEqual } from "@/lib/facebook/signature";

/** Returns an error Response when the request is not authorised, otherwise null. */
export function requireAdmin(req: Request): Response | null {
  const secret = appConfig.adminSecret;
  if (!secret) {
    return Response.json({ error: "ADMIN_SECRET is not configured on the server" }, { status: 503 });
  }
  const given = req.headers.get("x-admin-secret") ?? "";
  if (!safeEqual(given, secret)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

const PAGE_ID_RE = /^[A-Za-z0-9_\-]{1,64}$/;
export function cleanPageId(v: string | null | undefined): string {
  return v && PAGE_ID_RE.test(v) ? v : "demo";
}
