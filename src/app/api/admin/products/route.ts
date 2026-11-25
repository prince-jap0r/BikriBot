import { z } from "zod";
import { cleanPageId, requireAdmin } from "@/lib/admin-auth";
import { getRepo } from "@/lib/repo";

export const dynamic = "force-dynamic";

const Body = z.object({
  pageId: z.string().optional(),
  product: z.object({
    id: z.string().uuid().optional(),
    sku: z.string().max(40).nullable().optional(),
    name: z.string().min(1).max(120),
    description: z.string().max(500).optional(),
    category: z.string().max(60).optional(),
    price: z.number().int().min(0).max(10_000_000),
    stock: z.number().int().min(0).max(1_000_000),
    is_active: z.boolean().optional(),
  }),
});

export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid product data" }, { status: 400 });
  const repo = await getRepo();
  try {
    await repo.upsertProduct(cleanPageId(parsed.data.pageId), parsed.data.product);
  } catch (e) {
    console.error("[admin/products]", e);
    return Response.json({ error: "Could not save product (duplicate SKU?)" }, { status: 409 });
  }
  return Response.json({ ok: true });
}
