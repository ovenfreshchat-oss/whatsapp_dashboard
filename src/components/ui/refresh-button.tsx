"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/** Re-runs the page's server checks and says clearly when it is working and when it is done. */
export function RefreshButton({ label = "Refresh", className }: { label?: string; className?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState(false);
  const wasPending = useRef(false);

  useEffect(() => {
    if (wasPending.current && !pending) {
      setDone(true);
      const timer = setTimeout(() => setDone(false), 2500);
      return () => clearTimeout(timer);
    }
    wasPending.current = pending;
  }, [pending]);

  return <button
    type="button"
    className={className}
    disabled={pending}
    aria-busy={pending}
    onClick={() => { setDone(false); startTransition(() => router.refresh()); }}
    style={{ cursor: pending ? "progress" : "pointer", fontFamily: "inherit" }}
  >
    <span role="status" aria-live="polite">{pending ? "Checking…" : done ? "Updated ✓" : `${label} ↻`}</span>
  </button>;
}
