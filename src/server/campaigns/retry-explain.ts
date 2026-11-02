
/** Words for the reasons a failed message cannot be retried or put into a new campaign. */
const HOLD_REASON_TEXT: Record<string, string> = {
  retry_exhausted: "3 retries failed. Do Not Send, needs a manual review",
  repeated_131049: "Failed in 3 or more campaigns. Do Not Send, needs a manual review",
  undeliverable_131026: "Undeliverable (131026). Verify the number, then review it manually",
  cooldown_131056: "Cooling down after error 131056",
  manual_review: "On hold for a manual review",
};

export type RetryExplainInput = {
  retryStatus: "recovered" | "pending" | "exhausted" | "stopped" | "eligible" | "not_retryable";
  errorCode: string;
  attemptsMade: number;
  retryReadyAt: string | null;
  contactStatus: string | null;
  contactReason?: string | null;
};

function utc(value: string | null): string {
  if (!value) return "later";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "later" : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Plain-language reason a message is not retryable right now. Null when it can be retried now. */
export function explainRetry(input: RetryExplainInput, now: Date = new Date()): string | null {
  const status = input.contactStatus;
  switch (input.retryStatus) {
    case "recovered": return "Delivered after a retry.";
    case "pending": return "A retry is already queued or sent. We wait for its result.";
    case "exhausted": return "All 3 retries failed. The contact is on Do Not Send for a manual review.";
    case "stopped": return "A retry ended without a clear answer, so it is not repeated automatically.";
    case "eligible": {
      const ready = input.retryReadyAt ? new Date(input.retryReadyAt) : null;
      if (ready && ready.valueOf() > now.valueOf()) {
        return `Waiting. WhatsApp needs a gap before the next try. Eligible from ${utc(input.retryReadyAt)}.`;
      }
      return null;
    }
    default: break;
  }
  if (status === "opt_out") return "Global Opt Out. Never messaged again.";
  if (status === "do_not_send") {
    return `${HOLD_REASON_TEXT[input.contactReason ?? ""] ?? HOLD_REASON_TEXT.manual_review}.`;
  }
  switch (input.errorCode) {
    case "131049": return input.attemptsMade >= 3 ? "All 3 retries were used." : "Not retryable right now.";
    case "131026": return "Undeliverable (131026). Verify the number first. It is never retried.";
    case "131050": return "The person stopped marketing messages (131050). Added to Global Opt Out.";
    case "131048": return "WhatsApp limited your business number (131048). Sending is paused. The contact is not blamed.";
    case "131056": return "Too many messages to this person from your number (131056). Wait for the cooldown.";
    case "131047": return "More than 24 hours since they last wrote. Only an approved template can be sent.";
    default: return `Error ${input.errorCode} is not retried automatically.`;
  }
}

const EXCLUSION_TEXT: Record<string, string> = {
  recovered: "Already delivered after a retry",
  retry_pending: "A retry is in progress",
  not_a_saved_contact: "Not a saved contact",
  global_opt_out: "Global Opt Out",
  not_allowed_marketing: "Suppressed or not allowed marketing messages",
  undeliverable_131026: "Undeliverable (131026)",
  opted_out_131050: "Stopped marketing (131050)",
  waiting_131049: "Still inside the 24 hour wait after error 131049",
  hold_retry_exhausted: "Do Not Send: 3 retries failed",
  hold_repeated_131049: "Do Not Send: failed in 3 or more campaigns",
  hold_undeliverable_131026: "Do Not Send: undeliverable (131026)",
  hold_cooldown_131056: "Cooling down after error 131056",
  hold_manual_review: "Do Not Send: manual review",
};

/** Words for an exclusion code from failed_contact_eligibility(). */
export function describeExclusion(reason: string | null | undefined): string {
  if (!reason) return "Eligible";
  return EXCLUSION_TEXT[reason] ?? (reason.startsWith("hold_") ? "Do Not Send: manual review" : "Not eligible");
}
