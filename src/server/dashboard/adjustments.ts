import { createStaffAdminClient } from "@/server/auth/staff-users/admin";
import type { WorkspaceMetrics } from "./metrics";
import { ADJUSTMENT_METRICS, emptyAdjustments, type AdjustmentMetric, type MetricAdjustments } from "./adjustments-math";

/** Read on every dashboard render (one tiny query, not cached) so a saved change shows at once. */
export async function getMetricAdjustments(): Promise<MetricAdjustments> {
  const result = emptyAdjustments();
  const admin = createStaffAdminClient();
  if (!admin) return result;
  const { data, error } = await admin.from("dashboard_metric_adjustments").select("metric,value");
  if (error || !data) return result;
  for (const row of data) {
    if ((ADJUSTMENT_METRICS as readonly string[]).includes(row.metric) && Number.isInteger(row.value)) {
      result[row.metric as AdjustmentMetric] = row.value;
    }
  }
  return result;
}

/** What the database itself counts for each metric, before any manual baseline. */
export function databaseCounts(metrics: WorkspaceMetrics | null): Record<AdjustmentMetric, number> | null {
  if (!metrics || metrics.campaignSent == null || metrics.campaignDelivered == null) return null;
  return {
    messages_sent: metrics.campaignSent + (metrics.replySent ?? 0),
    messages_delivered: metrics.campaignDelivered + (metrics.replyDelivered ?? 0),
    marketing: metrics.campaignSent,
    utility: 0,
    authentication: 0,
  };
}
