"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import type { CampaignState } from "@/server/campaigns/store";
import { transitionCampaignAction, type CampaignActionState } from "./actions";
import styles from "./campaigns.module.css";

const initialState: CampaignActionState = { error: "", success: "" };

/** `datetime-local` value (local time, no zone) for a Date. */
function toLocalInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Next occurrence of `hour:00` (today if still ahead by 5+ minutes, otherwise tomorrow). */
function nextAt(hour: number, forceTomorrow = false): Date {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  if (forceTomorrow || date.getTime() < Date.now() + 5 * 60_000) date.setDate(date.getDate() + 1);
  return date;
}

const presets: { label: string; at: () => Date }[] = [
  { label: "In 1 hour", at: () => new Date(Date.now() + 60 * 60_000) },
  { label: "Evening 6 PM", at: () => nextAt(18) },
  { label: "Tomorrow 10 AM", at: () => nextAt(10, true) },
];

function ActionButton({ intent, label, danger = false, disabled = false }: {
  intent: "schedule" | "send_now" | "pause" | "resume" | "cancel";
  label: string;
  danger?: boolean;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return <button
    className={danger ? styles.dangerButton : styles.primaryButton}
    name="intent"
    value={intent}
    type="submit"
    disabled={pending || disabled}
  >{pending ? "Updating…" : label}</button>;
}

export function CampaignControls({ id, state, audienceCount, audienceSourceLabel, reviewSha256 }: {
  id: string;
  state: CampaignState;
  audienceCount: number;
  audienceSourceLabel: string;
  reviewSha256: string;
}) {
  const [result, action] = useActionState(transitionCampaignAction.bind(null, id), initialState);
  const [mode, setMode] = useState<"now" | "later">("now");
  const [localTime, setLocalTime] = useState("");
  const parsed = localTime ? new Date(localTime) : null;
  const scheduledForIso = parsed && Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : "";
  const canSchedule = state === "draft" && audienceCount > 0;
  const summary = parsed && scheduledForIso
    ? `${parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`
    : "";

  return <div className={styles.controls}>
    <form action={action} className={styles.form}>
      {canSchedule && <>
        <div className={styles.segment} role="radiogroup" aria-label="When to send">
          <button type="button" role="radio" aria-checked={mode === "now"}
            className={mode === "now" ? styles.segmentOn : ""} onClick={() => setMode("now")}>Send now</button>
          <button type="button" role="radio" aria-checked={mode === "later"}
            className={mode === "later" ? styles.segmentOn : ""} onClick={() => setMode("later")}>Schedule</button>
        </div>
        {mode === "later" && <div className={styles.whenBox}>
          <div className={styles.chips}>
            {presets.map((preset) => <button type="button" key={preset.label}
              className={styles.chip} onClick={() => setLocalTime(toLocalInput(preset.at()))}>{preset.label}</button>)}
          </div>
          <label className={styles.field}>
            <span>Or pick a date and time</span>
            <input type="datetime-local" value={localTime} onChange={(event) => setLocalTime(event.target.value)} />
          </label>
          {summary && <p className={styles.whenSummary}>Sends {summary}</p>}
        </div>}
        <input type="hidden" name="scheduledForIso" value={mode === "later" ? scheduledForIso : ""} />
        <input type="hidden" name="reviewAudienceCount" value={audienceCount} />
        <input type="hidden" name="reviewSha256" value={reviewSha256} />
        <div className={styles.stickyBar}>
          <label className={styles.reviewCheck}>
            <input type="checkbox" name="reviewAcknowledged" value="yes" required />
            <span>I checked the message and the {audienceCount} recipients ({audienceSourceLabel}).</span>
          </label>
          <ActionButton
            intent={mode === "now" ? "send_now" : "schedule"}
            label={mode === "now" ? `Send now to ${audienceCount}` : "Schedule campaign"}
            disabled={mode === "later" && !scheduledForIso}
          />
        </div>
        <p className={styles.helper}>Sends only inside the sending window and skips anyone who opted out. Pause any time from this page.</p>
      </>}
      {state === "draft" && audienceCount === 0 && <p className={styles.helper}>This draft has no eligible recipients. Import contacts and verify consent, then create a new draft.</p>}
      {(state === "scheduled" || state === "running") && <div className={styles.buttonRow}>
        <ActionButton intent="pause" label="Pause campaign" />
        <ActionButton intent="cancel" label="Cancel remaining" danger />
      </div>}
      {state === "paused" && <div className={styles.buttonRow}>
        <ActionButton intent="resume" label="Resume campaign" />
        <ActionButton intent="cancel" label="Cancel remaining" danger />
      </div>}
      {(state === "canceled" || state === "completed") && <p className={styles.helper}>This campaign has ended. Its audience and history remain available for review.</p>}
      {result.error && <p className={styles.formError} role="alert">{result.error}</p>}
      {result.success && <p className={styles.formSuccess} role="status">{result.success}</p>}
    </form>
  </div>;
}
