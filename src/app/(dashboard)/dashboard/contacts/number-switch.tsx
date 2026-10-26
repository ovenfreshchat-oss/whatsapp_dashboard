"use client";

import { useState, useTransition } from "react";
import { setBatchActiveAction, setContactActiveAction } from "./number-actions";
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
