"use client";

import { useActionState, useEffect, useRef, useState, type MouseEvent } from "react";
import { useFormStatus } from "react-dom";
import { Spinner } from "@/components/ui/spinner";
import { useFeedback, type ConfirmOptions } from "@/components/ui/feedback";
import type { CampaignState } from "@/server/campaigns/store";
import { transitionCampaignAction, type CampaignActionState } from "./actions";
import { formatDateTime, nextLocalHour, utcToLocalInput, zonedLocalToUtc } from "@/lib/timezone";
import styles from "./campaigns.module.css";

const initialState: CampaignActionState = { error: "", success: "" };

/** Presets give a `datetime-local` value in the client's zone (see src/lib/timezone.ts), never the browser's zone. */
const presets: { label: string; at: (timeZone: string) => string }[] = [
  { label: "In 1 hour", at: (timeZone) => utcToLocalInput(Date.now() + 60 * 60_000, timeZone) },
  { label: "Evening 6 PM", at: (timeZone) => nextLocalHour(18, timeZone) },
  { label: "Tomorrow 10 AM", at: (timeZone) => nextLocalHour(10, timeZone, true) },
];

type Intent = "schedule" | "send_now" | "pause" | "resume" | "cancel";

const PENDING_LABEL: Record<Intent, string> = {
  schedule: "Scheduling…",
  send_now: "Sending…",
  pause: "Pausing…",
  resume: "Resuming…",
  cancel: "Canceling…",
};

const SUCCESS_TITLE: Record<Intent, string> = {
  schedule: "Campaign scheduled",
  send_now: "Campaign queued for sending",
  pause: "Campaign paused",
  resume: "Campaign resumed",
  cancel: "Remaining messages canceled",
};

const ERROR_TITLE: Record<Intent, string> = {
  schedule: "Could not schedule the campaign",
  send_now: "Could not send the campaign",
  pause: "Could not pause the campaign",
  resume: "Could not resume the campaign",
  cancel: "Could not cancel the campaign",
};

/**
 * Submit button for one campaign action. When `confirmWith` is given, the user must confirm in a
 * dialog before the form is submitted; declining leaves everything as it was.
 */
function ActionButton({ intent, label, danger = false, disabled = false, confirmWith, onBefore }: {
  intent: Intent;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  confirmWith?: ConfirmOptions;
  /** Return false to stop the submit (used for validation messages). */
  onBefore?: () => boolean;
}) {
  const { pending } = useFormStatus();
  const { confirm } = useFeedback();
  const [mine, setMine] = useState(false);
  const busy = pending && mine;

  async function onClick(event: MouseEvent<HTMLButtonElement>) {
    const button = event.currentTarget;
    const form = button.form;
    event.preventDefault();
    if (pending || !form) return;
    if (onBefore && !onBefore()) return;
    if (confirmWith && !(await confirm(confirmWith))) return;
    setMine(true);
    form.requestSubmit(button);
  }

  useEffect(() => { if (!pending) setMine(false); }, [pending]);

  return <button
    className={danger ? styles.dangerButton : styles.primaryButton}
    name="intent"
    value={intent}
    type="submit"
    disabled={pending || disabled}
    aria-busy={busy || undefined}
    onClick={onClick}
  >{busy ? <><Spinner /> {PENDING_LABEL[intent]}</> : label}</button>;
}

export function CampaignControls({ id, state, audienceCount, audienceSourceLabel, reviewSha256, timeZone }: {
  id: string;
  /** The client's zone. The time typed below is read in this zone, whatever the browser's zone is. */
  timeZone: string;
  state: CampaignState;
  audienceCount: number;
  audienceSourceLabel: string;
  reviewSha256: string;
}) {
  const [result, action] = useActionState(transitionCampaignAction.bind(null, id), initialState);
  const { toast } = useFeedback();
  const lastIntent = useRef<Intent>("schedule");
  const handled = useRef(result);
  const [ackError, setAckError] = useState("");
  const [timeError, setTimeError] = useState("");
  useEffect(() => {
    if (result === handled.current) return;
    handled.current = result;
    const intent = lastIntent.current;
    if (result.error) toast({ tone: "error", title: ERROR_TITLE[intent], message: result.error });
    else if (result.success) toast({ tone: "success", title: SUCCESS_TITLE[intent], message: result.success });
  }, [result, toast]);
  const [mode, setMode] = useState<"now" | "later">("now");
  const [localTime, setLocalTime] = useState("");
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const converted = localTime ? zonedLocalToUtc(localTime, timeZone) : null;
  const scheduledForIso = converted?.ok ? converted.iso : "";
  const placeName = timeZone.split("/").pop()?.replace(/_/g, " ") ?? timeZone;
  const canSchedule = state === "draft" && audienceCount > 0;
  const summary = scheduledForIso ? `${formatDateTime(scheduledForIso, timeZone)} (${placeName} time)` : "";
  const timeNote = converted && !converted.ok
    ? "That time does not exist on that date because the clocks move forward. Pick another time."
    : converted?.ok && converted.ambiguous
      ? "That time happens twice on that date because the clocks move back. The first one is used."
      : "";

  return <div className={styles.controls}>
    <form action={action} className={styles.form} noValidate onSubmitCapture={(event) => {
      const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
      if (submitter?.value) lastIntent.current = submitter.value as Intent;
    }}>
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
              className={activePreset === preset.label ? `${styles.chip} ${styles.chipOn}` : styles.chip}
              aria-pressed={activePreset === preset.label}
              onClick={() => { setLocalTime(preset.at(timeZone)); setActivePreset(preset.label); }}>{preset.label}</button>)}
          </div>
          <label className={styles.field}>
            <span>Or pick a date and time ({placeName} time)</span>
            <input type="datetime-local" value={localTime} onChange={(event) => { setLocalTime(event.target.value); setActivePreset(null); }} />
          </label>
          {summary && <p className={styles.whenSummary}>Sends {summary}</p>}
          {timeNote && <p className={styles.formError} role="alert">{timeNote}</p>}
        </div>}
        <input type="hidden" name="scheduledForIso" value={mode === "later" ? scheduledForIso : ""} />
        <input type="hidden" name="reviewAudienceCount" value={audienceCount} />
        <input type="hidden" name="reviewSha256" value={reviewSha256} />
        <div className={styles.stickyBar}>
          <label className={styles.reviewCheck}>
            <input type="checkbox" name="reviewAcknowledged" value="yes" onChange={() => setAckError("")} aria-invalid={ackError ? true : undefined} aria-describedby={ackError ? "ack-error" : undefined} />
            <span>I checked the message and the {audienceCount} recipients ({audienceSourceLabel}).</span>
          </label>
          {ackError && <p id="ack-error" className={styles.formError} role="alert">{ackError}</p>}
          {timeError && <p className={styles.formError} role="alert">{timeError}</p>}
          <ActionButton
            intent={mode === "now" ? "send_now" : "schedule"}
            label={mode === "now" ? `Send now to ${audienceCount}` : "Schedule campaign"}
            disabled={mode === "later" && !scheduledForIso}
            onBefore={() => {
              const box = document.querySelector<HTMLInputElement>('input[name="reviewAcknowledged"]');
              setTimeError("");
              if (mode === "later" && (!scheduledForIso || Date.parse(scheduledForIso) < Date.now() + 2 * 60_000)) {
                setTimeError("Pick a date and time at least a few minutes from now.");
                return false;
              }
              if (!box?.checked) {
                setAckError("Tick the box to confirm you checked the message and the recipients.");
                return false;
              }
              setAckError("");
              return true;
            }}
            confirmWith={mode === "now" ? {
              title: `Send to ${audienceCount} ${audienceCount === 1 ? "person" : "people"} now?`,
              description: "Messages go to real WhatsApp users within about a minute, during your allowed sending hours. People who opted out are skipped. You can pause or cancel the rest after sending starts, but messages already sent cannot be recalled.",
              confirmLabel: `Send to ${audienceCount}`,
              cancelLabel: "Not yet",
            } : undefined}
          />
        </div>
        <p className={styles.helper}>Sends only inside the sending window and skips anyone who opted out. Pause any time from this page.</p>
      </>}
      {state === "draft" && audienceCount === 0 && <p className={styles.helper}>This draft has no eligible recipients. Import contacts and verify consent, then create a new draft.</p>}
      {(state === "scheduled" || state === "running") && <div className={styles.buttonRow}>
        <ActionButton intent="pause" label="Pause campaign" />
        <ActionButton intent="cancel" label="Cancel remaining" danger confirmWith={{
          title: "Cancel the remaining messages?",
          description: "Messages that have not been sent yet will be canceled and cannot be restarted. Messages already sent stay sent. The campaign ends.",
          confirmLabel: "Cancel remaining",
          cancelLabel: "Keep sending",
          tone: "danger",
        }} />
      </div>}
      {state === "paused" && <div className={styles.buttonRow}>
        <ActionButton intent="resume" label="Resume campaign" />
        <ActionButton intent="cancel" label="Cancel remaining" danger confirmWith={{
          title: "Cancel the remaining messages?",
          description: "Messages that have not been sent yet will be canceled and cannot be restarted. Messages already sent stay sent. The campaign ends.",
          confirmLabel: "Cancel remaining",
          cancelLabel: "Keep sending",
          tone: "danger",
        }} />
      </div>}
      {(state === "canceled" || state === "completed") && <p className={styles.helper}>This campaign has ended. Its audience and history remain available for review.</p>}
      {result.error && <p className={styles.formError} role="alert">{result.error}</p>}
      {result.success && <p className={styles.formSuccess} role="status">{result.success}</p>}
    </form>
  </div>;
}
