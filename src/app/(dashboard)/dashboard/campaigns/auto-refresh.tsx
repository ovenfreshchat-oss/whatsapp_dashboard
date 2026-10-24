"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import styles from "./campaigns.module.css";

/** Re-renders the server page every few seconds while the tab is visible, so progress updates itself. */
export function AutoRefresh({ intervalMs, label = "Updating live" }: { intervalMs: number; label?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const onVisibility = () => {
      const isVisible = document.visibilityState === "visible";
      setVisible(isVisible);
      if (isVisible) startTransition(() => router.refresh());
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [router]);

  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => startTransition(() => router.refresh()), intervalMs);
    return () => clearInterval(timer);
  }, [visible, intervalMs, router]);

  return <span className={styles.liveBadge} role="status" aria-live="off">
    <span className={pending ? styles.liveDotBusy : styles.liveDot} aria-hidden="true" />{label}
  </span>;
}
