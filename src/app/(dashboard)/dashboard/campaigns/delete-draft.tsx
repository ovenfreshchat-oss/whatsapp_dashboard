"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { deleteDraftCampaignAction } from "./actions";
import styles from "./campaigns.module.css";

/** Delete a draft in two taps: the trash button, then "Delete" to confirm. */
export function DeleteDraftButton({ id, name, redirectTo, label = false }: {
  id: string;
  name: string;
  redirectTo?: string;
  label?: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  function remove() {
    setError("");
    start(async () => {
      const result = await deleteDraftCampaignAction(id);
      if (result.error) { setError(result.error); return; }
      if (redirectTo) router.push(redirectTo); else router.refresh();
    });
  }

  if (!confirming) {
    return <button type="button" className={label ? styles.deleteText : styles.deleteIcon} onClick={() => setConfirming(true)}
      aria-label={`Delete draft ${name}`} title="Delete draft">
      <Trash2 size={18} aria-hidden="true" />{label && <span>Delete draft</span>}
    </button>;
  }
  return <span className={styles.confirmBox} role="group" aria-label={`Confirm deleting ${name}`}>
    <span>Delete this draft?</span>
    <button type="button" className={styles.confirmYes} onClick={remove} disabled={pending}>{pending ? "Deleting…" : "Delete"}</button>
    <button type="button" className={styles.confirmNo} onClick={() => setConfirming(false)} disabled={pending}>Keep</button>
    {error && <small className={styles.switchErrorText} role="alert">{error}</small>}
  </span>;
}
