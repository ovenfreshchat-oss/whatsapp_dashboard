"use client";

import { useActionState } from "react";
import { addOptOutNumbers, releaseOptOutNumber, type OptOutState } from "./actions";
import styles from "../contacts/contacts.module.css";

const initial: OptOutState = { error: "", success: "" };

export function AddOptOutForm() {
  const [state, action, pending] = useActionState(addOptOutNumbers, initial);
  return <form action={action} className={styles.stack}>
    <label className={styles.field}><span>Phone numbers with country code (one per line, or separated by commas)</span>
      <textarea name="numbers" rows={6} required placeholder={"+919746298851\n+96891234567"} /></label>
    <label className={styles.field}><span>Source or reason</span><input name="source" maxLength={200} required placeholder="e.g. customer asked on a call" /></label>
    <button className={styles.button} type="submit" disabled={pending}>{pending ? "Saving…" : "Add to opt-out list"}</button>
    {state.error && <p className={styles.error} role="alert">{state.error}</p>}
    {state.success && <p className={styles.success} role="status">{state.success}</p>}
  </form>;
}

export function ReleaseOptOutButton({ id }: { id: string }) {
  const [state, action, pending] = useActionState(releaseOptOutNumber, initial);
  return <form action={action}>
    <input type="hidden" name="id" value={id} />
    <button className={styles.secondaryButton} type="submit" disabled={pending}>Remove</button>
    {state.error && <small role="alert">{state.error}</small>}
  </form>;
}
