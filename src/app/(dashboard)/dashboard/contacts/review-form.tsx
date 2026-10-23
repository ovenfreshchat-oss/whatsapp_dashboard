"use client";

import { useActionState } from "react";
import { reviewImportedConsentClaim, type ConsentReviewState } from "./actions";
import styles from "./contacts.module.css";

const initial: ConsentReviewState = { error: "", success: "" };

export function ConsentReviewForm({ eventId, canGrant }: { eventId: string; canGrant: boolean }) {
  const [state, action, pending] = useActionState(reviewImportedConsentClaim, initial);
  return (
    <form action={action} className={styles.reviewForm}>
      <input type="hidden" name="eventId" value={eventId} />
      <label className={styles.field}><span>Consent source</span><input name="source" maxLength={200} required placeholder="e.g. checkout signup" /></label>
      <label className={styles.field}><span>Exact WhatsApp marketing notice shown</span><textarea name="noticeText" rows={2} maxLength={2000} required placeholder="The wording this contact agreed to" /></label>
      <div className={styles.reviewActions}>
        <button className={styles.button} type="submit" name="decision" value="grant" disabled={!canGrant || pending}>Approve consent</button>
        <button className={styles.secondaryButton} type="submit" name="decision" value="reject" formNoValidate disabled={pending}>Reject claim</button>
      </div>
      {!canGrant && <p className={styles.muted}>Approval needs a per-person evidence reference and a valid date or zoned time. Date-only claims wait until that date has ended worldwide.</p>}
      {state.error && <p className={styles.error} role="alert">{state.error}</p>}
      {state.success && <p className={styles.success} role="status">{state.success}</p>}
    </form>
  );
}
