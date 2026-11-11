"use client";

import { useEffect, useSyncExternalStore } from "react";
import { Loader2 } from "lucide-react";
import styles from "./page-loading.module.css";

/** True while a loading skeleton is on screen, so the sidebar can keep its spinner going. */
let active = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function usePageLoading() {
  return useSyncExternalStore(subscribe, () => active > 0, () => false);
}

/** Drop into any loading.tsx: a top progress bar, a "Loading" chip, and a spinning sidebar icon. */
export function PageLoadingSignal({ label = "Loading…" }: { label?: string }) {
  useEffect(() => {
    active += 1; emit();
    return () => { active -= 1; emit(); };
  }, []);
  return <>
    <div className={styles.bar} role="progressbar" aria-label={label} />
    <div className={styles.chip} role="status"><Loader2 size={16} className={styles.spin} aria-hidden="true" />{label}</div>
  </>;
}
