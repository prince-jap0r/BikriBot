import { z } from "zod";
import { requireAdmin } from "@/lib/admin-auth";
import { getRepo } from "@/lib/repo";

export const dynamic = "force-dynamic";

const Body = z.object({
  page_id: z.string().regex(/^[A-Za-z0-9_\-]{1,64}$/),
  shop_name: z.string().min(1).max(80).optional(),
  agent_name: z.string().min(1).max(40).optional(),
  shop_info: z.string().max(1000).optional(),
  // Write-only. Empty/undefined keeps the existing token.
  page_access_token: z.string().max(600).optional(),
  is_active: z.boolean().optional(),
});

/** Create / update a tenant (Facebook Page). */
export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid page data" }, { status: 400 });
  const { page_access_token, ...rest } = parsed.data;
  const repo = await getRepo();
  await repo.upsertPage({ ...rest, ...(page_access_token ? { page_access_token } : {}) });
  return Response.json({ ok: true });
}
