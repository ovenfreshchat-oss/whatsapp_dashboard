"use client";

import { useEffect, useState } from "react";
import { formatClockTime, formatLongDate } from "@/lib/timezone";
import styles from "./zone-clock.module.css";

/** Live date and time in the client's zone, with EST or EDT as it changes through the year. */
export function ZoneClock({ timeZone }: { timeZone: string }) {
  // Empty until the browser has mounted, so the server and browser never disagree about the seconds.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const place = timeZone.split("/").pop()?.replace(/_/g, " ") ?? timeZone;
  return <div className={styles.clock} role="timer" aria-label={`Current time in ${place}`}>
    <strong>{now === null ? " " : formatClockTime(now, timeZone)}</strong>
    <span>{now === null ? " " : `${formatLongDate(now, timeZone)} · ${place}`}</span>
  </div>;
}
