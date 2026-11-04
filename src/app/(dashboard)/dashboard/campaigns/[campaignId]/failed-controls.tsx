"use client";

import { useActionState, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/ui/spinner";
import { useActionToast, useFeedback } from "@/components/ui/feedback";
import {
  reactivateContactAction, resolveSenderAlertAction, retryFailedMessagesAction, setAutoRetryAction,
  type RetryActionState,
} from "./failed-actions";
import styles from "../../contacts/contacts.module.css";

const initial: RetryActionState = { error: "", success: "" };

/** Retries belong to one campaign and always ask first, with the number of messages that will be queued. */
export function RetryButton({ campaignId, campaignName, ready, waiting }: {
  campaignId: string; campaignName: string; ready: number; waiting: number;
}) {
  const { confirm, toast } = useFeedback();
  const [pending, start] = useTransition();
  async function run() {
    const ok = await confirm({
      title: `Retry ${ready} ${ready === 1 ? "message" : "messages"}?`,
      description: <>Only failed messages of <strong>{campaignName}</strong> whose waiting time has passed are queued.
        {waiting > 0 && <> {waiting} more {waiting === 1 ? "is" : "are"} still waiting and will not be sent.</>} They send one at a time inside your sending window.</>,
      confirmLabel: `Retry ${ready}`,
      cancelLabel: "Cancel",
    });
    if (!ok) return;
    start(async () => {
      const form = new FormData();
      form.set("campaignId", campaignId);
      let result: RetryActionState = { error: "The retry could not be queued. Check your connection and try again.", success: "" };
      try { result = await retryFailedMessagesAction(initial, form); } catch { /* keep default */ }
      toast(result.error ? { tone: "error", title: "Retry not queued", message: result.error } : { tone: "success", title: "Retry queued", message: result.success });
    });
  }
  return <button className={styles.button} type="button" onClick={run} disabled={pending || ready === 0} aria-busy={pending || undefined}>
    {pending ? <><Spinner /> Queuing…</> : `Retry Eligible${ready > 0 ? ` (${ready})` : ""}`}
  </button>;
}

export function AutoRetryForm({ campaignId, enabled, delays }: { campaignId: string; enabled: boolean; delays: number[] }) {
  const [state, action, pending] = useActionState(setAutoRetryAction, initial);
  useActionToast(state, { success: "Auto retry updated", error: "Auto retry not changed" });
  return <form action={action} className={styles.stack} key={`${campaignId}-${enabled}-${delays.join("-")}`}>
    <input type="hidden" name="campaignId" value={campaignId} />
    <div className={styles.delayGrid}>
      {[1, 2, 3].map((n) => <label className={styles.field} key={n}>
        <span>{["First", "Second", "Third"][n - 1]} retry after (hours)</span>
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
export function ReactivateButton({ phone, campaignId }: { phone: string; campaignId: string }) {
  const { confirm, toast } = useFeedback();
  const [pending, start] = useTransition();
  async function run() {
    const ok = await confirm({
      title: "Allow this number in campaigns again?",
      description: <><strong>{phone}</strong> will be included in future campaigns. Earlier failures stop counting, and it is blocked again if it fails again. A Global Opt Out is not changed.</>,
      confirmLabel: "Reactivate",
      cancelLabel: "Keep blocked",
    });
    if (!ok) return;
    start(async () => {
      const form = new FormData();
      form.set("phone", phone);
      form.set("campaignId", campaignId);
      let result: RetryActionState = { error: "The number could not be reactivated. Check your connection and try again.", success: "" };
      try { result = await reactivateContactAction(initial, form); } catch { /* keep default */ }
      toast(result.error ? { tone: "error", title: "Not reactivated", message: result.error } : { tone: "success", title: "Reactivated", message: result.success });
    });
  }
  return <button className={styles.secondaryButton} type="button" onClick={run} disabled={pending} aria-busy={pending || undefined} aria-label={`Reactivate ${phone}`}>
    {pending ? <><Spinner /> Working…</> : "Review"}
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

export const SELECTION_KEY = "solalyn.failedSelection";

/**
 * Select eligible failed contacts in the table above (checkboxes named "failureId" inside the form `formId`), or use every
 * eligible contact in the campaign. The choice is kept in this browser tab only and the composer reads it.
 */
export function CreateFromSelected({ campaignId, formId, eligibleTotal }: { campaignId: string; formId: string; eligibleTotal: number }) {
  const router = useRouter();
  const { toast } = useFeedback();
  const [all, setAll] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  function go() {
    const form = document.getElementById(formId) as HTMLFormElement | null;
    const picked = form ? [...form.querySelectorAll<HTMLInputElement>('input[name="failureId"]:checked')].map((box) => box.value) : [];
    if (!all && picked.length === 0) {
      toast({ tone: "error", title: "Nothing selected", message: "Tick at least one eligible contact, or choose every eligible contact in this campaign." });
      return;
    }
    try {
      sessionStorage.setItem(SELECTION_KEY, JSON.stringify({ campaignId, ids: all ? null : picked }));
    } catch {
      toast({ tone: "error", title: "Could not keep the selection", message: "Allow site storage in this browser and try again." });
      return;
    }
    router.push(`/dashboard/campaigns?view=new&from=${campaignId}`);
  }
  return <div className={styles.actions} style={{ justifyContent: "space-between", width: "100%" }}>
    <label className={styles.muted} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <input type="checkbox" checked={all} onChange={(event) => setAll(event.target.checked)} />
      Use every eligible contact in this campaign ({eligibleTotal})
    </label>
    <button ref={ref} className={styles.button} type="button" onClick={go}>Create New Campaign with Selected Contacts</button>
  </div>;
}
