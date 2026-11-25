import { z } from "zod";
import { cleanPageId, requireAdmin } from "@/lib/admin-auth";
import { getRepo } from "@/lib/repo";

export const dynamic = "force-dynamic";

const Body = z.object({
  pageId: z.string().optional(),
  orderId: z.string().uuid(),
  status: z.enum(["pending", "confirmed", "shipped", "delivered", "cancelled"]),
});

export async function PATCH(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid body" }, { status: 400 });
  const repo = await getRepo();
  try {
    await repo.updateOrderStatus(cleanPageId(parsed.data.pageId), parsed.data.orderId, parsed.data.status);
  } catch (error) {
    console.error("[admin/orders] status update failed:", error instanceof Error ? error.message : "unknown error");
    const missing = error instanceof Error && /not found|did not affect a row/i.test(error.message);
    return Response.json({ error: "Could not update order status" }, { status: missing ? 404 : 500 });
  }
  return Response.json({ ok: true });
}
