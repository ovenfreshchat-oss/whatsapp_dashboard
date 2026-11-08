import type { Metadata } from "next";
import { SenderAlertBanner } from "@/components/ui/sender-alert-banner";
import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { Inbox, Plus } from "lucide-react";
import { getStaffReadSession } from "@/server/auth/staff-users/admin";
import { DeliverySection, LastCampaignSection, MetricsSection, QualityBanner } from "./sections";
import { parseCampaignFilter, parseDateParam } from "@/server/campaigns/retries";
import ui from "@/components/ui/ui.module.css";
import styles from "./dashboard.module.css";
import { ZoneClock } from "@/components/ui/zone-clock";
import { getClientTimeZone } from "@/lib/timezone";

export const metadata: Metadata = {
  title: "Dashboard | Solalyn",
};

function MetricsSkeleton() {
  return <div className={styles.metricGrid} aria-busy="true" aria-label="Loading metrics">
    {Array.from({ length: 3 }, (_, index) => <div key={index} className={`${ui.skeleton} ${styles.metricSkeleton}`} />)}
  </div>;
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ from?: string | string[]; to?: string | string[]; campaign?: string | string[] }> }) {
  const params = await searchParams;
  const from = parseDateParam(first(params.from));
  const to = parseDateParam(first(params.to));
  const campaignId = parseCampaignFilter(first(params.campaign));
  const { access, workspaceAccess } = await getStaffReadSession();
  if (workspaceAccess === "signed-out") redirect("/sign-in");
  const isAdmin = workspaceAccess === "allowed"; // admin or staff: may see metrics and start campaigns
  if (!isAdmin) redirect("/access-denied");

  return (
    <div className={styles.content}>
      <SenderAlertBanner />
      <div className={styles.header}>
        <div>
          <h1>Dashboard</h1>
          <p>Your WhatsApp contacts, campaigns and delivery at a glance.</p>
        </div>
        {isAdmin && <div className={styles.headerActions}>
          <ZoneClock timeZone={getClientTimeZone()} />
          <Link href="/dashboard/inbox" className={`${ui.btn} ${ui.btnSecondary}`}><Inbox size={16} aria-hidden="true" />Open inbox</Link>
          <Link href="/dashboard/campaigns?view=new" className={`${ui.btn} ${ui.btnPrimary}`}><Plus size={16} aria-hidden="true" />New campaign</Link>
        </div>}
      </div>

      {isAdmin && <Suspense fallback={null}><QualityBanner /></Suspense>}

      {isAdmin ? <Suspense fallback={<MetricsSkeleton />}><MetricsSection /></Suspense>
        : <p className={ui.notice}>Metrics are available to workspace members.</p>}

      {isAdmin && <Suspense fallback={null}><DeliverySection from={from} to={to} /></Suspense>}

      {isAdmin && <Suspense fallback={<div className={`${ui.skeleton} ${styles.lastSkeleton}`} aria-busy="true" aria-label="Loading last campaign" />}>
        <LastCampaignSection />
      </Suspense>}
    </div>
  );
}
