import { getWorkspaceAccess } from "@/server/auth/staff-users/admin";
import { createHeaderVideoUpload } from "@/server/campaigns/media";

export const runtime = "nodejs";

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, { status, headers: { "Cache-Control": "no-store" } });
}

/** Gives the browser a one-time slot to upload a header video (MP4) straight to storage. */
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  try {
    if (!origin || new URL(origin).origin !== new URL(request.url).origin) return json({ error: "Request origin is not allowed." }, 403);
  } catch {
    return json({ error: "Request origin is invalid." }, 403);
  }
  if (await getWorkspaceAccess() !== "allowed") return json({ error: "You don't have permission to do this." }, 403);
  try {
    return json(await createHeaderVideoUpload());
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "The video upload could not be started." }, 502);
  }
}
