"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { excludeRecipientsAction, type CampaignActionState } from "./actions";
import styles from "./campaigns.module.css";

const initialState: CampaignActionState = { error: "", success: "" };

function Submit({ intent, label, plain = false }: { intent: string; label: string; plain?: boolean }) {
  const { pending } = useFormStatus();
  return <button type="submit" name="intent" value={intent} disabled={pending}
    className={plain ? styles.chip : styles.primaryButton}>{pending ? "Updating…" : label}</button>;
}

export function ExcludeNumbers({ campaignId, excluded }: {
  campaignId: string;
  excluded: { phone: string; name: string | null }[];
}) {
  const [result, action] = useActionState(excludeRecipientsAction.bind(null, campaignId), initialState);
  return <details className={styles.excludeBox} open={excluded.length > 0 || undefined}>
    <summary>Skip some numbers{excluded.length ? ` (${excluded.length} skipped)` : ""}</summary>
    <form action={action} className={styles.form}>
      <label className={styles.field}>
        <span>Paste numbers not to message (one per line, any format, with country code)</span>
        <textarea name="numbers" rows={3} placeholder={"e.g. +91 98765 43210\n+1 416 555 0123"} />
      </label>
      <div className={styles.buttonRow}>
        <Submit intent="exclude" label="Skip these numbers" />
      </div>
      {excluded.length > 0 && <div className={styles.excludedList}>
        <strong>Skipped ({excluded.length})</strong>
        <ul>{excluded.map((item) => <li key={item.phone}>{item.name ? `${item.name} · ` : ""}{item.phone}</li>)}</ul>
        <Submit intent="restore_all" label="Put all back" plain />
      </div>}
      {result.error && <p className={styles.formError} role="alert">{result.error}</p>}
      {result.success && <p className={styles.formSuccess} role="status">{result.success}</p>}
    </form>
  </details>;
}
