"use client";

import { useActionState } from "react";
import { recordContactConsent, type RecordConsentState } from "./record-actions";
import styles from "./contacts.module.css";

const initial: RecordConsentState = { error: "", success: "" };

export function ConsentRecordForm({ contactId, idempotencyKey }: { contactId: string; idempotencyKey: string }) {
  const [state, action, pending] = useActionState(recordContactConsent, initial);
  return <form action={action} className={styles.recordForm}>
    <input type="hidden" name="contactId" value={contactId} />
    <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
    <p className={styles.muted}>Use this when the uploaded file has only a title and number, but you hold separate evidence of an earlier WhatsApp marketing opt-in. Do not create consent from the contact list alone.</p>
    <div className={styles.fieldGrid}>
      <label className={styles.field}><span>Source of consent or opt-out</span><input name="source" maxLength={200} required placeholder="e.g. checkout form" /></label>
      <label className={styles.field}><span>When it happened, with timezone</span><input name="occurredAt" required placeholder="2026-10-16T10:30:00+05:30" /></label>
    </div>
    <label className={styles.field}><span>Exact marketing notice shown to this person</span><textarea name="noticeText" maxLength={2000} rows={3} placeholder="Required for approving consent" /></label>
    <label className={styles.field}><span>Per-person evidence reference</span><input name="evidenceReference" maxLength={500} placeholder="Required for approving consent, e.g. form response ID" /></label>
    <div className={styles.reviewActions}>
      <button className={styles.button} type="submit" name="decision" value="grant" disabled={pending}>Record verified opt-in</button>
      <button className={styles.secondaryButton} type="submit" name="decision" value="revoke" formNoValidate disabled={pending}>Record opt-out</button>
    </div>
    {state.error && <p className={styles.error} role="alert">{state.error}</p>}
    {state.success && <p className={styles.success} role="status">{state.success}</p>}
  </form>;
}
