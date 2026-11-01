"use client";

import { useActionState, useTransition } from "react";
import { Spinner } from "@/components/ui/spinner";
import { useActionToast, useFeedback } from "@/components/ui/feedback";
import {
  reactivateContactAction, resolveSenderAlertAction, retryFailedMessagesAction, setAutoRetryAction,
  type RetryActionState,
} from "./actions";
import styles from "../contacts/contacts.module.css";

const initial: RetryActionState = { error: "", success: "" };

export function RetryButton({ campaignId, disabled }: { campaignId: string | null; disabled: boolean }) {
  const [state, action, pending] = useActionState(retryFailedMessagesAction, initial);
  useActionToast(state, { success: "Retry queued", error: "Retry not queued" });
  return <form action={action}>
    <input type="hidden" name="campaignId" value={campaignId ?? ""} />
    <button className={styles.button} type="submit" disabled={pending || disabled} aria-busy={pending || undefined}>
      {pending ? <><Spinner /> Queuing…</> : "Retry Failed Messages"}
    </button>
  </form>;
}

export function AutoRetryForm({ campaignId, enabled, delays }: { campaignId: string; enabled: boolean; delays: number[] }) {
  const [state, action, pending] = useActionState(setAutoRetryAction, initial);
  useActionToast(state, { success: "Auto retry updated", error: "Auto retry not changed" });
  return <form action={action} className={styles.stack} key={`${campaignId}-${enabled}-${delays.join("-")}`}>
    <input type="hidden" name="campaignId" value={campaignId} />
    <div className={styles.delayGrid}>
      {[1, 2, 3].map((n) => <label className={styles.field} key={n}>
        <span>Retry {n} after (hours)</span>
        <input name={`delay${n}`} inputMode="numeric" pattern="[0-9]*" maxLength={4} required defaultValue={delays[n - 1] ?? [24, 72, 168][n - 1]} />
      </label>)}
    </div>
    <div className={styles.actions}>
      <button className={styles.secondaryButton} type="submit" name="enabled" value="true" disabled={pending} aria-busy={pending || undefined}>
        {pending ? <><Spinner /> Saving…</> : enabled ? "Save auto retry" : "Enable Auto Retry"}
      </button>
      {enabled && <button className={styles.secondaryButton} type="submit" name="enabled" value="false" disabled={pending}>Turn off</button>}
    </div>
  </form>;
}

/** Putting a number back into campaigns is a human decision, so it asks first. */
export function ReactivateButton({ phone }: { phone: string }) {
  const { confirm, toast } = useFeedback();
  const [pending, start] = useTransition();
  async function run() {
    const ok = await confirm({
      title: "Allow this number in campaigns again?",
      description: <><strong>{phone}</strong> will be included in future campaigns. Earlier failures stop counting, and it is blocked again if it fails again.</>,
      confirmLabel: "Reactivate",
      cancelLabel: "Keep blocked",
    });
    if (!ok) return;
    start(async () => {
      const form = new FormData();
      form.set("phone", phone);
      let result: RetryActionState = { error: "The number could not be reactivated. Check your connection and try again.", success: "" };
      try { result = await reactivateContactAction(initial, form); } catch { /* keep default */ }
      toast(result.error ? { tone: "error", title: "Not reactivated", message: result.error } : { tone: "success", title: "Reactivated", message: result.success });
    });
  }
  return <button className={styles.secondaryButton} type="button" onClick={run} disabled={pending} aria-busy={pending || undefined} aria-label={`Reactivate ${phone}`}>
    {pending ? <><Spinner /> Working…</> : "Reactivate"}
  </button>;
}

export function ResolveAlertButton({ alertId }: { alertId: string }) {
  const [state, action, pending] = useActionState(resolveSenderAlertAction, initial);
  useActionToast(state, { success: "Alert handled", error: "Alert not updated" });
  return <form action={action}>
    <input type="hidden" name="alertId" value={alertId} />
    <button className={styles.secondaryButton} type="submit" disabled={pending}>{pending ? <><Spinner /> Saving…</> : "Mark as handled"}</button>
  </form>;
}
