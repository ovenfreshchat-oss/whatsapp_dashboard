import {
  DEFAULT_PREFERENCES, MAX_HISTORY, MAX_SEEN_IDS, RETENTION_DAYS, isMessageKind,
  type NotificationEvent, type NotificationPreferences, type StoredNotification,
} from "./types";

/** Everything kept in one LocalStorage key per signed-in reader. Bump VERSION if the shape changes. */
type NotificationState = {
  version: 1;
  prefs: NotificationPreferences;
  history: StoredNotification[];
  /** Ids already shown at least once, kept even after their notification is cleared, so a clear is permanent. */
  seenIds: string[];
  /** Last feed cursor processed, so a reload resumes instead of refetching from scratch. */
  cursor: string | null;
};

const VERSION = 1;
const PREFIX = "solalyn.notifications.v1";

function emptyState(): NotificationState {
  return { version: VERSION, prefs: { ...DEFAULT_PREFERENCES }, history: [], seenIds: [], cursor: null };
}

/** A stable, filesystem-safe fragment so each staff login gets its own notification history. */
export function readerKey(email: string | null | undefined): string {
  const safe = (email ?? "").trim().toLowerCase().replace(/[^a-z0-9@._-]/g, "");
  return `${PREFIX}.${safe || "default"}`;
}

function isPreferences(value: unknown): value is NotificationPreferences {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return typeof p.soundEnabled === "boolean" && typeof p.messageAlerts === "boolean"
    && typeof p.campaignAlerts === "boolean" && typeof p.volume === "number";
}

function isStoredNotification(value: unknown): value is StoredNotification {
  if (!value || typeof value !== "object") return false;
  const n = value as Record<string, unknown>;
  return typeof n.id === "string" && typeof n.kind === "string" && typeof n.title === "string"
    && typeof n.body === "string" && typeof n.href === "string" && typeof n.occurredAt === "string"
    && typeof n.read === "boolean";
}

function pruneHistory(history: StoredNotification[]): StoredNotification[] {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return history
    .filter((item) => {
      const time = Date.parse(item.occurredAt);
      return Number.isFinite(time) && time >= cutoff;
    })
    .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))
    .slice(0, MAX_HISTORY);
}

function sanitize(raw: unknown): NotificationState {
  if (!raw || typeof raw !== "object") return emptyState();
  const value = raw as Record<string, unknown>;
  const prefs = isPreferences(value.prefs) ? value.prefs : { ...DEFAULT_PREFERENCES };
  const history = Array.isArray(value.history) ? pruneHistory(value.history.filter(isStoredNotification)) : [];
  const seenIds = Array.isArray(value.seenIds) ? value.seenIds.filter((item): item is string => typeof item === "string").slice(-MAX_SEEN_IDS) : [];
  const cursor = typeof value.cursor === "string" ? value.cursor : null;
  return { version: VERSION, prefs, history, seenIds, cursor };
}

/** Never throws: a corrupt value, a blocked store (private mode) or a quota error all fall back silently. */
export function loadState(email: string | null | undefined): NotificationState {
  if (typeof window === "undefined") return emptyState();
  try {
    const raw = window.localStorage.getItem(readerKey(email));
    if (!raw) return emptyState();
    return sanitize(JSON.parse(raw));
  } catch {
    return emptyState();
  }
}

function saveState(email: string | null | undefined, state: NotificationState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(readerKey(email), JSON.stringify(state));
  } catch {
    // Storage full or unavailable (private browsing): the in-memory UI state still works for this tab.
  }
}

export type ApplyResult = { history: StoredNotification[]; unread: number; added: StoredNotification[]; cursor: string };

/**
 * Folds freshly-fetched events into the stored history: drops anything already seen (even if later
 * cleared), respects each category's alert toggle, prunes to the retention window and size cap, and
 * persists. Returns only the genuinely new notifications so the caller can decide whether to sound.
 */
export function applyEvents(email: string | null | undefined, events: NotificationEvent[], cursor: string): ApplyResult {
  const state = loadState(email);
  const seen = new Set(state.seenIds);
  const existingIds = new Set(state.history.map((item) => item.id));
  const added: StoredNotification[] = [];

  for (const event of events) {
    if (seen.has(event.id) || existingIds.has(event.id)) continue;
    const allowed = isMessageKind(event.kind) ? state.prefs.messageAlerts : state.prefs.campaignAlerts;
    seen.add(event.id);
    if (!allowed) continue;
    added.push({ ...event, read: false });
  }

  const history = pruneHistory([...added, ...state.history]);
  const seenIds = [...seen].slice(-MAX_SEEN_IDS);
  const next: NotificationState = { ...state, history, seenIds, cursor };
  saveState(email, next);
  return { history, unread: history.filter((item) => !item.read).length, added, cursor };
}

export function getPreferences(email: string | null | undefined): NotificationPreferences {
  return loadState(email).prefs;
}

export function setPreferences(email: string | null | undefined, prefs: NotificationPreferences): void {
  const state = loadState(email);
  saveState(email, { ...state, prefs });
}

export function getCursor(email: string | null | undefined): string | null {
  return loadState(email).cursor;
}

export function markRead(email: string | null | undefined, id: string): StoredNotification[] {
  const state = loadState(email);
  const history = state.history.map((item) => (item.id === id ? { ...item, read: true } : item));
  saveState(email, { ...state, history });
  return history;
}

export function markAllRead(email: string | null | undefined): StoredNotification[] {
  const state = loadState(email);
  const history = state.history.map((item) => ({ ...item, read: true }));
  saveState(email, { ...state, history });
  return history;
}

export function clearOne(email: string | null | undefined, id: string): StoredNotification[] {
  const state = loadState(email);
  const history = state.history.filter((item) => item.id !== id);
  saveState(email, { ...state, history });
  return history;
}

export function clearAll(email: string | null | undefined): StoredNotification[] {
  const state = loadState(email);
  saveState(email, { ...state, history: [] });
  return [];
}
