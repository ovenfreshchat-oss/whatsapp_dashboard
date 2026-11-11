"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { useFeedback } from "@/components/ui/feedback";
import { deleteBatchAction, setBatchActiveAction, setContactActiveAction } from "./number-actions";
import styles from "./contacts.module.css";

/** On/off switch for one number. Flips instantly and rolls back if saving fails. */
export function ActiveSwitch({ contactId, initial, name }: { contactId: string; initial: boolean; name: string }) {
  const [on, setOn] = useState(initial);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  function flip() {
    const next = !on;
    setOn(next);
    setError("");
    start(async () => {
      const result = await setContactActiveAction(contactId, next);
      if (result.error) { setOn(!next); setError(result.error); }
    });
  }

  return <span className={styles.switchWrap}>
    <span className={on ? styles.stateOn : styles.stateOff}>{on ? "Active" : "Inactive"}</span>
    <button type="button" role="switch" aria-checked={on} aria-label={`${name}: ${on ? "active" : "inactive"} for campaigns`}
      className={[styles.switch, on ? styles.switchOn : ""].filter(Boolean).join(" ")} onClick={flip} disabled={pending}>
      <span className={styles.switchKnob} />
    </button>
    {error && <small className={styles.switchError} role="alert">{error}</small>}
  </span>;
}

/** Turn every number in this upload on or off at once. */
export function BatchActiveButtons({ batchId }: { batchId: string }) {
  const [message, setMessage] = useState("");
  const [pending, start] = useTransition();

  function run(active: boolean) {
    setMessage("");
    start(async () => {
      const result = await setBatchActiveAction(batchId, active);
      setMessage(result.error || `${result.changed} number${result.changed === 1 ? "" : "s"} set to ${active ? "active" : "inactive"}.`);
    });
  }

  return <div className={styles.bulk}>
    <button type="button" className={styles.secondaryButton} onClick={() => run(true)} disabled={pending}>Activate all</button>
    <button type="button" className={styles.secondaryButton} onClick={() => run(false)} disabled={pending}>Deactivate all</button>
    {message && <span className={styles.bulkMessage} role="status">{message}</span>}
  </div>;
}

/** Deletes the whole upload (the list). Contacts and campaign history are kept. */
export function DeleteUploadButton({ batchId, fileName, compact = false }: { batchId: string; fileName: string; compact?: boolean }) {
  const { confirm, toast } = useFeedback();
  const router = useRouter();
  const [pending, start] = useTransition();
  async function run() {
    const ok = await confirm({
      title: "Delete this upload?",
      description: <><strong>{fileName}</strong> will be removed from your uploads and from the campaign list picker. The numbers stay saved as contacts, and past campaigns are not changed.</>,
      confirmLabel: "Delete upload",
      cancelLabel: "Keep it",
      tone: "danger",
    });
    if (!ok) return;
    start(async () => {
      let error = "Could not delete. Check your connection and try again.";
      try { error = (await deleteBatchAction(batchId)).error; } catch { /* keep default */ }
      if (error) { toast({ tone: "error", title: "Not deleted", message: error }); return; }
      toast({ tone: "success", title: "Upload deleted", message: `${fileName} was removed.` });
      if (compact) router.refresh(); else router.push("/dashboard/contacts");
    });
  }
  if (compact) return <button type="button" className={styles.iconRemove} onClick={run} disabled={pending} aria-busy={pending || undefined} aria-label={`Delete ${fileName}`} title="Delete list">
    <Trash2 size={16} aria-hidden="true" />
  </button>;
  return <button type="button" className={styles.secondaryButton} onClick={run} disabled={pending} aria-busy={pending || undefined}>
    <Trash2 size={16} aria-hidden="true" /> {pending ? "Deleting…" : "Delete upload"}
  </button>;
}
