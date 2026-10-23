"use client";

import { useActionState } from "react";
import { reconcileConfirmedSenderHold, releaseAmbiguousSenderHold, type HoldReviewState } from "./actions";
import styles from "./review.module.css";

const initial: HoldReviewState = { error: "", success: "" };

export function ReleaseHoldForm({
  wabaId,
  phoneNumberId,
  sourceItemKey,
}: {
  wabaId: string;
  phoneNumberId: string;
  sourceItemKey: string;
}) {
  const [state, action, pending] = useActionState(releaseAmbiguousSenderHold, initial);
  return <form action={action} className={styles.reviewForm}>
    <input type="hidden" name="wabaId" value={wabaId} />
    <input type="hidden" name="phoneNumberId" value={phoneNumberId} />
    <input type="hidden" name="sourceItemKey" value={sourceItemKey} />
    <label className={styles.field}>
      <span>Why is this message safe to clear?</span>
      <textarea name="reviewReason" minLength={10} maxLength={1000} rows={3} required
        placeholder="Record what you checked in the original message and why it is not an opt-out." />
    </label>
    <label className={styles.confirmation}>
      <input type="checkbox" name="reviewedEvidence" value="yes" required />
      <span>I reviewed this inbound message. Clearing the last pending message can let campaigns resume.</span>
    </label>
    <button type="submit" className={styles.releaseButton} disabled={pending}>
      {pending ? "Recording review…" : "Record review for this message"}
    </button>
    {state.error && <p className={styles.error} role="alert">{state.error}</p>}
    {state.success && <p className={styles.success} role="status">{state.success}</p>}
  </form>;
}

export function ReconcileConfirmedHoldForm({
  wabaId,
  phoneNumberId,
  sourceItemKey,
  providerIdentity,
}: {
  wabaId: string;
  phoneNumberId: string;
  sourceItemKey: string;
  providerIdentity: string;
}) {
  const [state, action, pending] = useActionState(reconcileConfirmedSenderHold, initial);
  return <form action={action} className={styles.reviewForm}>
    <input type="hidden" name="wabaId" value={wabaId} />
    <input type="hidden" name="phoneNumberId" value={phoneNumberId} />
    <input type="hidden" name="sourceItemKey" value={sourceItemKey} />
    <label className={styles.field}>
      <span>Recipient phone number matching WhatsApp ID {providerIdentity}</span>
      <input name="recipientE164" type="tel" pattern="\+[1-9][0-9]{7,14}"
        placeholder="+15551234567" required />
    </label>
    <label className={styles.field}>
      <span>How did you verify the STOP and recipient identity?</span>
      <textarea name="reviewReason" minLength={10} maxLength={1000} rows={3} required
        placeholder="Record the original STOP evidence and the recipient identity check." />
    </label>
    <label className={styles.confirmation}>
      <input type="checkbox" name="reviewedEvidence" value="yes" required />
      <span>I reviewed this exact inbound STOP and its WhatsApp sender identity.</span>
    </label>
    <label className={styles.confirmation}>
      <input type="checkbox" name="confirmedSuppression" value="yes" required />
      <span>I confirmed that this recipient-specific opt-out is stored and will remain active.</span>
    </label>
    <button type="submit" className={styles.releaseButton} disabled={pending}>
      {pending ? "Recording reconciliation…" : "Reconcile this STOP"}
    </button>
    {state.error && <p className={styles.error} role="alert">{state.error}</p>}
    {state.success && <p className={styles.success} role="status">{state.success}</p>}
  </form>;
}
