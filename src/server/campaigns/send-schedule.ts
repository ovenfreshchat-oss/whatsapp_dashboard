export type WorkerStatus = {
  running_pending: boolean;
  in_flight: boolean;
  next_scheduled_at: string | null;
};

export const MIN_WAIT_MS = 1_000;
export const MAX_WAIT_MS = 12 * 60 * 60 * 1000;
const IN_FLIGHT_POLL_MS = 60_000;
const SCAN_STEP_MS = 5 * 60 * 1000;
const SCAN_LIMIT_MS = 8 * 24 * 60 * 60 * 1000;

export function hasPendingWork(status: WorkerStatus): boolean {
  return status.running_pending || status.in_flight || status.next_scheduled_at !== null;
}

/**
 * While the send throttle is cooling down, never wake the workflow before the cooldown ends.
 * `throttledUntil` is the ISO time the tick reported (undefined when not throttled).
 */
export function applyThrottleWait(
  waitMs: number | null,
  throttledUntil: string | undefined,
  now: Date = new Date(),
): number | null {
  if (waitMs === null || !throttledUntil) return waitMs;
  const until = Date.parse(throttledUntil);
  if (!Number.isFinite(until) || until <= now.getTime()) return waitMs;
  return Math.max(waitMs, clamp(until - now.getTime()));
}

function clamp(ms: number): number {
  return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, Math.ceil(ms)));
}

/**
 * How long the workflow should sleep before the next tick, or null when nothing is left to do.
 * `isOpen` says whether sending is allowed at an instant (the configured send window).
 */
export function nextWaitMs(
  status: WorkerStatus,
  isOpen: (instant: Date) => boolean,
  now: Date = new Date(),
): number | null {
  if (!hasPendingWork(status)) return null;
  if (status.running_pending && isOpen(now)) return MIN_WAIT_MS;

  // Only parked in-flight rows remain: wait for stale-claim handling, then look again.
  if (!status.running_pending && status.in_flight && status.next_scheduled_at === null) {
    return clamp(IN_FLIGHT_POLL_MS);
  }

  let target = now.getTime();
  if (!status.running_pending && status.next_scheduled_at) {
    const scheduled = Date.parse(status.next_scheduled_at);
    if (Number.isFinite(scheduled)) target = Math.max(target, scheduled);
  }
  for (let t = target; t - target <= SCAN_LIMIT_MS; t += SCAN_STEP_MS) {
    if (isOpen(new Date(t))) return clamp(t - now.getTime());
  }
  return clamp(60 * 60 * 1000);
}
