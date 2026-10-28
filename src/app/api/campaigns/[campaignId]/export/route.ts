import { getWorkspaceAccess } from "@/server/auth/staff-users/admin";
import { assertCampaignId, getCampaignStore } from "@/server/campaigns/store";

export const dynamic = "force-dynamic";

/** Spreadsheet apps run text starting with these characters as formulas. */
function cell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export async function GET(_request: Request, context: { params: Promise<{ campaignId: string }> }) {
  if (await getWorkspaceAccess() !== "allowed") return new Response("Forbidden", { status: 403 });
  const { campaignId } = await context.params;
  try { assertCampaignId(campaignId); } catch { return new Response("Not found", { status: 404 }); }
  const store = getCampaignStore();
  const lines = [["Name", "Phone", "Send state", "Delivery status", "Last status at", "Error"].map(cell).join(",")];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await store.from("whatsapp_campaign_recipients")
      .select("contact_id,recipient_e164,state,delivery_status,last_status_at,error_summary")
      .eq("campaign_id", campaignId).order("created_at").order("id").range(from, from + 999);
    if (error) return new Response("Export failed", { status: 500 });
    if (!data?.length) break;
    const ids = data.map((r) => r.contact_id as string);
    const names = new Map<string, string>();
    const contacts = await store.from("contacts").select("id,display_name").in("id", ids);
    for (const c of contacts.data ?? []) names.set(c.id as string, (c.display_name as string | null) ?? "");
    for (const r of data) {
      lines.push([names.get(r.contact_id as string) ?? "", r.recipient_e164, r.state, r.delivery_status ?? "", r.last_status_at ?? "", r.error_summary ?? ""].map(cell).join(","));
    }
    if (data.length < 1000) break;
  }
  return new Response(lines.join("\r\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="campaign-${campaignId.slice(0, 8)}-results.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
