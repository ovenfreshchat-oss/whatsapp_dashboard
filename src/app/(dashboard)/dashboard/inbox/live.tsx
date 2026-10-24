"use client";

import { useEffect, useLayoutEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { markConversationRead } from "./actions";
import styles from "./inbox.module.css";

/** A reply the staff member just sent, shown instantly before the server has stored it. */
export type OptimisticEvent =
  | { type: "add"; id: string; conversationId: string; text: string; media: boolean }
  | { type: "sent"; id: string }
  | { type: "remove"; id: string };
const OPTIMISTIC_EVENT = "inbox:optimistic";
let sendsInFlight = 0;

export function emitOptimistic(detail: OptimisticEvent): void {
  if (detail.type === "add") sendsInFlight += 1;
  else if (detail.type === "sent" || detail.type === "remove") sendsInFlight = Math.max(0, sendsInFlight - 1);
  window.dispatchEvent(new CustomEvent<OptimisticEvent>(OPTIMISTIC_EVENT, { detail }));
}

type PendingBubble = { id: string; text: string; media: boolean; sent: boolean };

/**
 * Near-live updates: checks a tiny change token every 4 seconds while the tab is visible and
 * reloads the inbox only when something changed (new message, delivery tick, unread count).
 */
export function AutoRefresh({ intervalMs = 4_000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    let last: string | null = null;
    let busy = false;
    async function check() {
      // Hold the poll while a reply is on its way so it cannot draw the message twice.
      if (busy || sendsInFlight > 0 || document.visibilityState !== "visible") return;
      busy = true;
      try {
        const response = await fetch("/api/inbox/version", { cache: "no-store" });
        if (!response.ok) return;
        const { v } = await response.json() as { v?: string };
        if (typeof v !== "string") return;
        if (last !== null && v !== last) router.refresh();
        last = v;
      } catch {
        // offline or server restarting: try again on the next tick
      } finally {
        busy = false;
      }
    }
    void check();
    const timer = setInterval(check, intervalMs);
    document.addEventListener("visibilitychange", check);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", check); };
  }, [router, intervalMs]);
  return null;
}

/** Marks the open thread read, up to the newest message the page rendered. */
export function MarkRead({ conversationId, seenThrough }: { conversationId: string; seenThrough: string }) {
  const [, startTransition] = useTransition();
  useEffect(() => {
    startTransition(() => { void markConversationRead(conversationId, seenThrough); });
  }, [conversationId, seenThrough]);
  return null;
}

/**
 * The message list. Opens at the newest message and stays pinned to the bottom as new
 * messages arrive, unless the reader scrolled up to read older ones.
 */
export function MessageList({ conversationId, className, children }: { conversationId: string; className: string; children: ReactNode }) {
  const ref = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const lastConversation = useRef<string | null>(null);
  const [pending, setPending] = useState<PendingBubble[]>([]);

  useEffect(() => {
    setPending([]);
    function onEvent(event: Event) {
      const detail = (event as CustomEvent<OptimisticEvent>).detail;
      setPending((current) => {
        if (detail.type === "add") {
          return detail.conversationId === conversationId
            ? [...current, { id: detail.id, text: detail.text, media: detail.media, sent: false }]
            : current;
        }
        if (detail.type === "remove") return current.filter((item) => item.id !== detail.id);
        return current.map((item) => (item.id === detail.id ? { ...item, sent: true } : item));
      });
    }
    window.addEventListener(OPTIMISTIC_EVENT, onEvent);
    return () => window.removeEventListener(OPTIMISTIC_EVENT, onEvent);
  }, [conversationId]);

  // New server data arrived, so the real message replaces the temporary one.
  useEffect(() => {
    setPending((current) => (current.some((item) => item.sent) ? current.filter((item) => !item.sent) : current));
  }, [children]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (lastConversation.current !== conversationId) {
      lastConversation.current = conversationId;
      stick.current = true;
    }
    if (stick.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <ol
      ref={ref}
      className={className}
      onScroll={(event) => {
        const el = event.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      // Images and videos change the height after they load.
      onLoadCapture={() => { const el = ref.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }}
    >
      {children}
      {pending.map((item) => (
        <li key={item.id} className={[styles.bubbleRow, styles.rowOut].join(" ")}>
          <div className={[styles.bubble, styles.bubbleOut].join(" ")}>
            {item.media && <p className={styles.bubbleText}>📎 Attachment</p>}
            {item.text && <p className={styles.bubbleText}>{item.text}</p>}
            <span className={styles.bubbleMeta}>{item.sent ? "Sent" : "Sending…"}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}
