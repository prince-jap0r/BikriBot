import { after } from "next/server";
import { z } from "zod";
import { runAgent } from "@/lib/ai/agent";
import { cleanPageId, requireAdmin } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  pageId: z.string().optional(),
  sessionId: z.string().regex(/^[A-Za-z0-9_\-]{6,64}$/),
  text: z.string().min(1).max(1500),
});

/** Test chat endpoint for the admin UI (no Facebook involved). Protected by x-admin-secret. */
export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid body" }, { status: 400 });
  const { pageId, sessionId, text } = parsed.data;

  const result = await runAgent({ pageId: cleanPageId(pageId), psid: `web-${sessionId}`, text });
  if (!result) return Response.json({ error: "Ignored (inactive page or duplicate)" }, { status: 409 });

  after(() => result.finalize());

  return Response.json({
    reply: result.reply,
    failed: result.failed,
    error: result.error,
    debug: {
      stage: result.stage,
      modules: result.modules,
      tools: result.tools,
      model: result.model,
      approxPromptTokens: result.approxPromptTokens,
    },
  });
}
