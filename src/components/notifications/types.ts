/** Shared between the server event feed and the client-side LocalStorage store. */

export type NotificationKind = "message" | "conversation" | "campaign_completed" | "campaign_failed";

/** One business event, as reported by the server. Never persisted server-side. */
export type NotificationEvent = {
  /** Stable and deterministic (e.g. "msg:<id>"), so the client can drop ones it has already seen. */
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  href: string;
  occurredAt: string;
};

export type NotificationFeedResponse = { now: string; events: NotificationEvent[] };

/** A notification as kept in LocalStorage, with the reader's own read state. */
export type StoredNotification = NotificationEvent & { read: boolean };

export type NotificationPreferences = {
  soundEnabled: boolean;
  messageAlerts: boolean;
  campaignAlerts: boolean;
  /** 0 to 1. */
  volume: number;
};

export const DEFAULT_PREFERENCES: NotificationPreferences = {
  soundEnabled: true,
  messageAlerts: true,
  campaignAlerts: true,
  volume: 0.6,
};

export const MAX_HISTORY = 100;
export const MAX_SEEN_IDS = 300;
export const RETENTION_DAYS = 7;

export function isMessageKind(kind: NotificationKind): boolean {
  return kind === "message" || kind === "conversation";
}
