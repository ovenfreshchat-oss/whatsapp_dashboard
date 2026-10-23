import { sleep } from "workflow";
import {
  getCampaignWorkerReadiness,
  isWithinCampaignSendWindow,
  runCampaignWorkerTick,
} from "@/server/campaigns/worker";
import { getCampaignStore } from "@/server/campaigns/store";
import { applyThrottleWait, nextWaitMs, type WorkerStatus } from "@/server/campaigns/send-schedule";
import { startCampaignSendWorkflow } from "@/server/campaigns/start-send";

/** About 5 events per iteration; Workflow allows 25,000 per run, so hand off well before that. */
const MAX_ITERATIONS = 1_500;
const LEASE_TTL_SECONDS = 120;
const ERROR_BACKOFF_MS = 60_000;

type TickResult =
  | { kind: "lease_lost" }
  | { kind: "idle"; reason: string }
  | { kind: "error" }
  | { kind: "ok"; claimed: number; waitMs: number | null };

/**
 * Runs the existing worker tick under the single-sender lease.
 * This step must never be retried: a failure after Meta accepted a message would send it twice.
 * The worker already records a possible send as "uncertain" for manual reconciliation, and this
 * step catches everything so the workflow engine never sees a thrown error.
 */
async function tickStep(holder: string): Promise<TickResult> {
  "use step";
  try {
    const store = getCampaignStore();
    const lease = await store.rpc("acquire_campaign_worker_lease", {
      p_holder: holder,
      p_ttl_seconds: LEASE_TTL_SECONDS,
    });
    if (lease.error) return { kind: "error" };
    if (lease.data !== true) return { kind: "lease_lost" };

    const tick = await runCampaignWorkerTick();
    if (!tick.enabled) return { kind: "idle", reason: tick.reason ?? "Sending is not enabled." };

    const status = await store.rpc("campaign_worker_status");
    if (status.error || !status.data) return { kind: "error" };
    const policy = getCampaignWorkerReadiness();
    const isOpen = policy.enabled
      ? (instant: Date) => isWithinCampaignSendWindow(policy, instant)
      : () => false;
    const waitMs = applyThrottleWait(
      nextWaitMs(status.data as WorkerStatus, isOpen),
      tick.throttledUntil,
    );
    return { kind: "ok", claimed: tick.claimed, waitMs };
  } catch {
    // No contact, token, or provider detail is logged or returned.
    return { kind: "error" };
  }
}
tickStep.maxRetries = 0;

async function releaseLeaseStep(holder: string): Promise<void> {
  "use step";
  await getCampaignStore().rpc("release_campaign_worker_lease", { p_holder: holder });
}

/** Safe to retry: it only reads state, and a duplicate start exits on the lease. */
async function continueIfWorkRemainsStep(): Promise<boolean> {
  "use step";
  const status = await getCampaignStore().rpc("campaign_worker_status");
  if (status.error || !status.data) return false;
  const s = status.data as WorkerStatus;
  if (!(s.running_pending || s.next_scheduled_at !== null)) return false;
  if (!getCampaignWorkerReadiness().enabled) return false;
  return startCampaignSendWorkflow();
}

export async function campaignSendWorkflow(holder: string) {
  "use workflow";

  let reason = "iteration_limit";
  for (let i = 0; i < MAX_ITERATIONS; i += 1) {
    const result = await tickStep(holder);
    if (result.kind === "lease_lost") return { status: "another_sender_active" };
    if (result.kind === "idle") {
      reason = "idle";
      break;
    }
    if (result.kind === "error") {
      await sleep(ERROR_BACKOFF_MS);
      continue;
    }
    if (result.waitMs === null) {
      reason = "done";
      break;
    }
    await sleep(result.waitMs);
  }

  await releaseLeaseStep(holder);
  // Catches work that arrived while shutting down, and the iteration cap.
  const continued = reason === "idle" ? false : await continueIfWorkRemainsStep();
  return { status: reason, continued };
}
