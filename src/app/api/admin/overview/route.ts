import { activeApiKey, aiConfig } from "@/config/ai.config";
import { facebookConfig } from "@/config/facebook.config";
import { cleanPageId, requireAdmin } from "@/lib/admin-auth";
import { getRepo } from "@/lib/repo";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const pageId = cleanPageId(new URL(req.url).searchParams.get("pageId"));
  const repo = await getRepo();
  const [pages, stats, orders, products, customers, zones] = await Promise.all([
    repo.listPages(),
    repo.stats(pageId),
    repo.listOrders(pageId, 30),
    repo.listProducts(pageId, { includeInactive: true }),
    repo.listCustomers(pageId, 20),
    repo.getDeliveryZones(pageId),
  ]);

  return Response.json({
    pageId,
    // Access tokens are write-only: never sent back to the browser.
    pages: pages.map(({ page_access_token, ...p }) => ({ ...p, has_token: !!page_access_token })),
    stats,
    orders,
    products,
    customers,
    zones,
    setup: {
      dbDriver: repo.driver,
      aiProvider: aiConfig.provider,
      defaultModel: aiConfig.defaultModel,
      fallbackModel: aiConfig.fallbackModel,
      aiKeySet: !!activeApiKey(),
      fbPageIdSet: !!facebookConfig.pageId,
      fbPageTokenSet: !!facebookConfig.pageAccessToken,
      fbVerifyTokenSet: !!facebookConfig.verifyToken,
      fbAppSecretSet: !!facebookConfig.appSecret,
      signatureVerification: facebookConfig.verifySignature,
      webhookPath: "/api/webhook/facebook",
    },
  });
}
