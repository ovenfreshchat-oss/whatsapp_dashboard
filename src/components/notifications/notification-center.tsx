"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, Check, MessageSquare, Megaphone, Trash2, TriangleAlert, Volume2, X } from "lucide-react";
import {
  applyEvents, clearAll, clearOne, getCursor, getPreferences, loadState, markAllRead, markRead, readerKey, setPreferences,
} from "./storage";
import { isSoundUnlocked, playCampaignSound, playMessageSound, unlockSound } from "./sound";
import { isMessageKind, type NotificationFeedResponse, type NotificationPreferences, type StoredNotification } from "./types";
import styles from "./notification-center.module.css";

const POLL_MS = 15_000;
const FEED_URL = "/api/notifications/events";

function timeAgo(iso: string): string {
  const diffMs = Date.now() - Date.parse(iso);
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function icon(kind: StoredNotification["kind"]) {
  if (kind === "campaign_completed") return <Check size={16} aria-hidden="true" />;
  if (kind === "campaign_failed") return <TriangleAlert size={16} aria-hidden="true" />;
  return <MessageSquare size={16} aria-hidden="true" />;
}

export function NotificationCenter({ email }: { email: string | null | undefined }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [history, setHistory] = useState<StoredNotification[]>([]);
  const [prefs, setPrefs] = useState<NotificationPreferences>(() => getPreferences(email));
  const [unlocked, setUnlocked] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<{ left: number; top: number } | { left: number; bottom: number } | null>(null);

  // Initial load, and keep this tab in sync when another tab changes the same reader's storage.
  useEffect(() => {
    const state = loadState(email);
    setHistory(state.history);
    setPrefs(state.prefs);
    setUnlocked(isSoundUnlocked());
    function onStorage(event: StorageEvent) {
      if (event.key !== readerKey(email)) return;
      const next = loadState(email);
      setHistory(next.history);
      setPrefs(next.prefs);
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [email]);

  // Poll a tiny delta feed while the tab is visible; fold results into LocalStorage and sound if due.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let busy = false;
    async function tick() {
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      try {
        const since = getCursor(email);
        const url = since ? `${FEED_URL}?since=${encodeURIComponent(since)}` : FEED_URL;
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json() as NotificationFeedResponse;
        if (typeof data.now !== "string" || !Array.isArray(data.events)) return;
        const result = applyEvents(email, data.events, data.now);
        setHistory(result.history);
        if (result.added.length > 0) {
          const freshPrefs = getPreferences(email);
          if (freshPrefs.soundEnabled) {
            if (result.added.some((item) => isMessageKind(item.kind))) playMessageSound(freshPrefs.volume);
            if (result.added.some((item) => !isMessageKind(item.kind))) playCampaignSound(freshPrefs.volume);
          }
        }
      } catch {
        // Offline or the server is restarting: the next tick tries again.
      } finally {
        busy = false;
      }
    }
    void tick();
    timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => { if (timer) clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [email]);

  const place = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(360, window.innerWidth - 16);
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow < 260 && rect.top > spaceBelow) {
      setPanelStyle({ left, bottom: Math.max(8, window.innerHeight - rect.top + 8) });
    } else {
      setPanelStyle({ left, top: rect.bottom + 8 });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    function onOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) { if (event.key === "Escape") setOpen(false); }
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, place]);

  async function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next) {
      // Opening the bell is a real user gesture: a good, unobtrusive moment to lift the autoplay block.
      if (await unlockSound()) setUnlocked(true);
    }
  }

  function updatePrefs(patch: Partial<NotificationPreferences>) {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    setPreferences(email, next);
  }

  async function enableSound() {
    const ok = await unlockSound();
    setUnlocked(ok);
    if (ok) playMessageSound(prefs.volume);
  }

  function openItem(item: StoredNotification) {
    setHistory(markRead(email, item.id));
    setOpen(false);
    router.push(item.href);
  }

  const unread = history.filter((item) => !item.read).length;
  const badge = unread > 99 ? "99+" : String(unread);

  return (
    <div className={styles.root}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.bell}
        onClick={() => void toggleOpen()}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
      >
        <Bell size={20} aria-hidden="true" />
        {unread > 0 && <span className={styles.badge}>{badge}</span>}
      </button>

      {open && panelStyle && (
        <div ref={panelRef} className={styles.panel} style={panelStyle} role="dialog" aria-label="Notifications">
          <div className={styles.panelHead}>
            <strong>Notifications</strong>
            <div className={styles.panelHeadActions}>
              {unread > 0 && <button type="button" className={styles.textButton} onClick={() => setHistory(markAllRead(email))}>Mark all read</button>}
              <button type="button" className={styles.iconButton} aria-label="Notification settings" aria-pressed={showSettings}
                onClick={() => setShowSettings((value) => !value)}><Volume2 size={16} aria-hidden="true" /></button>
            </div>
          </div>

          {showSettings && (
            <div className={styles.settings}>
              <label className={styles.settingRow}>
                <input type="checkbox" checked={prefs.soundEnabled} onChange={(event) => updatePrefs({ soundEnabled: event.target.checked })} />
                Sound
              </label>
              <label className={styles.settingRow}>
                <input type="checkbox" checked={prefs.messageAlerts} onChange={(event) => updatePrefs({ messageAlerts: event.target.checked })} />
                New message alerts
              </label>
              <label className={styles.settingRow}>
                <input type="checkbox" checked={prefs.campaignAlerts} onChange={(event) => updatePrefs({ campaignAlerts: event.target.checked })} />
                Campaign alerts
              </label>
              <label className={styles.settingRow}>
                Volume
                <input type="range" min={0} max={1} step={0.05} value={prefs.volume}
                  onChange={(event) => updatePrefs({ volume: Number(event.target.value) })} disabled={!prefs.soundEnabled} />
              </label>
              {!unlocked && (
                <button type="button" className={styles.enableSound} onClick={() => void enableSound()}>
                  <Megaphone size={14} aria-hidden="true" /> Enable sound
                </button>
              )}
            </div>
          )}

          <ul className={styles.list}>
            {history.length === 0 && <li className={styles.empty}>No notifications yet.</li>}
            {history.map((item) => (
              <li key={item.id} className={item.read ? styles.item : `${styles.item} ${styles.itemUnread}`}>
                <button type="button" className={styles.itemButton} onClick={() => openItem(item)}>
                  <span className={styles.itemIcon} data-kind={item.kind}>{icon(item.kind)}</span>
                  <span className={styles.itemText}>
                    <strong>{item.title}</strong>
                    <span>{item.body}</span>
                    <time>{timeAgo(item.occurredAt)}</time>
                  </span>
                </button>
                <button type="button" className={styles.clearButton} aria-label="Clear notification"
                  onClick={() => setHistory(clearOne(email, item.id))}><X size={14} aria-hidden="true" /></button>
              </li>
            ))}
          </ul>

          {history.length > 0 && (
            <div className={styles.panelFoot}>
              <button type="button" className={styles.textButton} onClick={() => setHistory(clearAll(email))}>
                <Trash2 size={14} aria-hidden="true" /> Clear all
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
