import Link from "next/link";
import { loadOpenSenderAlerts } from "@/server/campaigns/retries";
import styles from "./ui.module.css";

/** Shown while Meta has restricted the business number (131048). Campaigns on it are paused. */
export async function SenderAlertBanner() {
  const alerts = await loadOpenSenderAlerts();
  if (!alerts.length) return null;
  return <section className={styles.warning} role="alert" style={{ flexDirection: "column", gap: 4 }}>
    <strong>WhatsApp limited your business number ({alerts[0].code})</strong>
    <span>Campaigns on this number were paused and retries are on hold. Do not resume until the number&apos;s quality rating recovers in WhatsApp Manager.{" "}
      <Link href="/dashboard/campaigns">Open campaigns</Link></span>
  </section>;
}
