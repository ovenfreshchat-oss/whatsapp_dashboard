import type { Metadata } from "next";
import { BackLink } from "@/components/ui/back-link";
import { databaseCounts, getMetricAdjustments } from "@/server/dashboard/adjustments";
import { getLiveMetrics } from "@/server/dashboard/metrics";
import { AdjustForm, type AdjustRow } from "./adjust-form";
import styles from "./adjust.module.css";

export const metadata: Metadata = { title: "Adjust totals | The Oven Fresh" };

export default async function AdjustTotalsPage() {
  const [metrics, adjustments] = await Promise.all([getLiveMetrics(), getMetricAdjustments()]);
  const base = databaseCounts(metrics);
  const categoriesFromMeta = Boolean(metrics?.categories);

  const rows: AdjustRow[] = base ? [
    { metric: "messages_sent", label: "Messages sent", counted: base.messages_sent, current: base.messages_sent + adjustments.messages_sent },
    { metric: "messages_delivered", label: "Delivered", counted: base.messages_delivered, current: base.messages_delivered + adjustments.messages_delivered },
    { metric: "marketing", label: "Marketing", counted: base.marketing, current: base.marketing + adjustments.marketing, hint: categoriesFromMeta ? "Meta is already supplying this card" : undefined },
    { metric: "utility", label: "Utility", counted: base.utility, current: adjustments.utility, hint: categoriesFromMeta ? "Meta is already supplying this card" : undefined },
    { metric: "authentication", label: "Authentication", counted: base.authentication, current: adjustments.authentication, hint: categoriesFromMeta ? "Meta is already supplying this card" : undefined },
  ] : [];

  return (
    <div className={styles.content}>
      <BackLink href="/dashboard">Back to dashboard</BackLink>
      <div className={styles.intro}>
        <h1>Adjust dashboard totals</h1>
        <p>
          Messages sent before this dashboard was connected are not in the database. Enter the real totals from Meta (WhatsApp Manager
          → Insights) and the dashboard will show them, then keep adding new sends on top. Leave a box empty to use only what the
          dashboard counted.
        </p>
      </div>
      <section className={styles.card}>
        {rows.length
          ? <AdjustForm rows={rows} />
          : <p className={styles.error} role="alert">The database counts are unavailable right now. Refresh in a moment.</p>}
      </section>
    </div>
  );
}
