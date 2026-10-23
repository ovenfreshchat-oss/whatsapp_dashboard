"use client";

import { useActionState } from "react";
import { reviewImportedConsentBatch, type BatchReviewState } from "./batch-actions";
import styles from "./contacts.module.css";

const initial: BatchReviewState = { error: "", success: "" };

export function BatchReviewForm({ batchId, idempotencyKey, reviewableCount }: {
  batchId: string;
  idempotencyKey: string;
  reviewableCount: number;
}) {
  const [state, action, pending] = useActionState(reviewImportedConsentBatch, initial);
  return <form action={action} className={styles.recordForm}>
    <input type="hidden" name="batchId" value={batchId} />
    <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
    <p className={styles.muted}>This reviews pending “Yes” claims with a per-person evidence reference and a valid consent date or zoned time. Date-only claims become reviewable after that calendar day has ended worldwide. Claims missing evidence or a date stay pending. An explicit “No” remains suppressed.</p>
    <label className={styles.field}><span>Where consent was collected</span><input name="source" maxLength={200} required placeholder="e.g. website checkout form" /></label>
    <label className={styles.field}><span>Exact WhatsApp marketing notice shown to every person in this batch</span><textarea name="noticeText" rows={4} maxLength={2000} required placeholder="Paste the wording people agreed to" /></label>
    <label className={styles.check}><input type="checkbox" name="reviewConfirmed" value="yes" required /> I checked the file’s “Yes” values, per-person evidence references, consent dates, and notice wording for this batch.</label>
    <button type="submit" className={styles.button} disabled={pending || reviewableCount === 0}>Approve up to {reviewableCount} evidenced claims</button>
    {state.error && <p className={styles.error} role="alert">{state.error}</p>}
    {state.success && <p className={styles.success} role="status">{state.success}</p>}
  </form>;
}
