"use client";

import { useActionState, useTransition } from "react";
import { Spinner } from "@/components/ui/spinner";
import { useActionToast, useFeedback } from "@/components/ui/feedback";
import { addOptOutNumbers, releaseOptOutNumber, type OptOutState } from "./actions";
import styles from "../contacts/contacts.module.css";

const initial: OptOutState = { error: "", success: "" };

export function AddOptOutForm() {
  const [state, action, pending] = useActionState(addOptOutNumbers, initial);
  useActionToast(state, { success: "Numbers added to the opt-out list", error: "Numbers not added" });
  return <form action={action} className={styles.stack}>
    <label className={styles.field}><span>Phone numbers with country code (one per line, or separated by commas)</span>
      <textarea name="numbers" rows={6} required placeholder={"+919746298851\n+96891234567"} /></label>
    <label className={styles.field}><span>Source or reason</span><input name="source" maxLength={200} required placeholder="e.g. customer asked on a call" /></label>
    <button className={styles.button} type="submit" disabled={pending} aria-busy={pending || undefined}>{pending ? <><Spinner /> Saving…</> : "Add to opt-out list"}</button>
    {state.error && <p className={styles.error} role="alert">{state.error}</p>}
  </form>;
}

/** Removing a number from the do-not-contact list makes it eligible for campaigns again, so it asks first. */
export function ReleaseOptOutButton({ id, phone }: { id: string; phone: string }) {
  const { confirm, toast } = useFeedback();
  const [pending, start] = useTransition();

  async function release() {
    const ok = await confirm({
      title: "Remove from the opt-out list?",
      description: <><strong>{phone}</strong> will be eligible to receive campaign messages again. Only do this if the person has asked to hear from you again.</>,
      confirmLabel: "Remove number",
      cancelLabel: "Keep opted out",
      tone: "danger",
    });
    if (!ok) return;
    start(async () => {
      const form = new FormData();
      form.set("id", id);
      let result: OptOutState = { error: "The number could not be removed. Check your connection and try again.", success: "" };
      try { result = await releaseOptOutNumber(initial, form); } catch { /* keep the default message */ }
      if (result.error) toast({ tone: "error", title: "Number not removed", message: result.error });
      else toast({ tone: "success", title: "Number removed", message: result.success || `${phone} is no longer on the opt-out list.` });
    });
  }

  return <button className={styles.secondaryButton} type="button" onClick={release} disabled={pending} aria-busy={pending || undefined} aria-label={`Remove ${phone} from the opt-out list`}>
    {pending ? <><Spinner /> Removing…</> : "Remove"}
  </button>;
}
