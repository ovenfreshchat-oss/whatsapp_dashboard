"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import type { CampaignState } from "@/server/campaigns/store";
import { transitionCampaignAction, type CampaignActionState } from "./actions";
import styles from "./campaigns.module.css";

const initialState: CampaignActionState = { error: "", success: "" };

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
  const [localTime, setLocalTime] = useState("");
  const parsed = localTime ? new Date(localTime) : null;
  const scheduledForIso = parsed && Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : "";
  const canSchedule = state === "draft" && audienceCount > 0;

  return <div className={styles.controls}>
    <form action={action} className={styles.form}>
      {canSchedule && <>
        <label className={styles.field}>
          <span>Or schedule for later (your local time zone)</span>
          <input
            type="datetime-local"
            value={localTime}
            onChange={(event) => setLocalTime(event.target.value)}
          />
        </label>
        <input type="hidden" name="scheduledForIso" value={scheduledForIso} />
        <input type="hidden" name="reviewAudienceCount" value={audienceCount} />
        <input type="hidden" name="reviewSha256" value={reviewSha256} />
        <label className={styles.reviewCheck}>
          <input type="checkbox" name="reviewAcknowledged" value="yes" required />
          <span>I reviewed the full template content, the {audienceSourceLabel} source, the total of {audienceCount} recipients, and the preview above.</span>
        </label>
        <p className={styles.helper}>Sending is done by the separate worker, only inside its configured sending window. <strong>Send now</strong> queues the campaign immediately; the worker starts within about a minute. Scheduling for later sends nothing until that time.</p>
        <div className={styles.buttonRow}>
          <ActionButton intent="send_now" label={`Send now to ${audienceCount} recipients`} />
          <ActionButton intent="schedule" label="Schedule for later" disabled={!scheduledForIso} />
        </div>
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
