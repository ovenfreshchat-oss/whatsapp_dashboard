"use client";

import { useEffect, useLayoutEffect, useRef, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { markConversationRead } from "./actions";

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
      if (busy || document.visibilityState !== "visible") return;
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
    </ol>
  );
}
