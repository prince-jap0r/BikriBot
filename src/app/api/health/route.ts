import { activeApiKey } from "@/config/ai.config";
import { facebookConfig } from "@/config/facebook.config";
import { isProductionWebhookConfigSafe } from "@/lib/facebook/webhook-safety";
import { isServiceReady } from "@/lib/readiness";
import { getRepo } from "@/lib/repo";

export const dynamic = "force-dynamic";

export async function GET() {
  let database = false;
  let driver: string | null = null;
  try {
    const repo = await getRepo();
    driver = repo.driver;
    database = await repo.ping();
  } catch {
    // Never return exception/configuration details from a public health endpoint.
  }

  const production = process.env.NODE_ENV === "production";
  const aiProviderConfigured = !!activeApiKey();
  const webhookSecurityConfigured =
    !!facebookConfig.verifyToken &&
    isProductionWebhookConfigSafe(process.env.NODE_ENV, facebookConfig.verifySignature, facebookConfig.appSecret);
  const ready = isServiceReady({ database, production, aiProviderConfigured, webhookSecurityConfigured });

  return Response.json(
    {
      live: true,
      ready,
      checks: { database, aiProviderConfigured, webhookSecurityConfigured },
      ...(driver ? { driver } : {}),
    },
    { status: ready ? 200 : 503 },
  );
}
