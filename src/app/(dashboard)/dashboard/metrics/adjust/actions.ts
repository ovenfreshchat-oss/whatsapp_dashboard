"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createStaffAdminClient, getStaffAdminAccess } from "@/server/auth/staff-users/admin";
import { ADJUSTMENT_METRICS, offsetFromMetaTotal, parseMetaTotal, type AdjustmentMetric } from "@/server/dashboard/adjustments-math";
import { databaseCounts } from "@/server/dashboard/adjustments";
import { getLiveMetrics } from "@/server/dashboard/metrics";

export type AdjustState = { error: string; success: string };

const LABELS: Record<AdjustmentMetric, string> = {
  messages_sent: "Messages sent",
  messages_delivered: "Delivered",
  marketing: "Marketing",
  utility: "Utility",
  authentication: "Authentication",
};

export async function saveMetricAdjustments(_previous: AdjustState, formData: FormData): Promise<AdjustState> {
  if (await getStaffAdminAccess() !== "allowed") {
    return { error: "You do not have permission to change the totals.", success: "" };
  }
  const admin = createStaffAdminClient();
  if (!admin) return { error: "The database is not configured.", success: "" };

  const { data: userData } = await (await createClient()).auth.getUser();
  const actorId = userData.user?.id ?? null;

  const base = databaseCounts(await getLiveMetrics());
  if (!base) return { error: "Could not read the current database counts. Try again in a moment.", success: "" };

  const upserts: { metric: AdjustmentMetric; value: number; updated_by: string | null }[] = [];
  const clears: AdjustmentMetric[] = [];

  for (const metric of ADJUSTMENT_METRICS) {
    const parsed = parseMetaTotal(formData.get(metric));
    if (parsed.kind === "invalid") {
      return { error: `${LABELS[metric]}: enter a whole number (0 or more), or leave it empty.`, success: "" };
    }
    if (parsed.kind === "blank") { clears.push(metric); continue; }
    const offset = offsetFromMetaTotal(parsed.total, base[metric]);
    if (offset === null) {
      return {
        error: `${LABELS[metric]}: Meta's total (${parsed.total.toLocaleString("en-US")}) is lower than the ${base[metric].toLocaleString("en-US")} this dashboard has already counted. Check the number.`,
        success: "",
      };
    }
    upserts.push({ metric, value: offset, updated_by: actorId });
  }

  if (upserts.length) {
    const { error } = await admin.from("dashboard_metric_adjustments").upsert(
      upserts.map((row) => ({ ...row, updated_at: new Date().toISOString() })),
      { onConflict: "metric" },
    );
    if (error) {
      return { error: "Could not save. Apply drizzle/0022_dashboard_metric_adjustments.sql in Supabase first, then try again.", success: "" };
    }
  }
  if (clears.length) {
    const { error } = await admin.from("dashboard_metric_adjustments").delete().in("metric", clears);
    if (error) return { error: "Could not clear the empty fields. Try again.", success: "" };
  }

  revalidatePath("/dashboard");
  revalidatePath("/dashboard/metrics/adjust");
  return { error: "", success: "Totals saved. The dashboard now shows these numbers." };
}
