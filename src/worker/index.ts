import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { runCampaignWorkerTick } from "../server/campaigns/worker";

// Match local Next configuration without overriding environment injected by the host.
for (const file of [".env.local", ".env"]) {
  const path = resolve(process.cwd(), file);
  if (existsSync(path)) loadEnvFile(path);
}

const POLL_MS = 5_000;
let stopping = false;
let lastIdleReason = "";

process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

async function sleep(milliseconds: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  while (!stopping) {
    try {
      const tick = await runCampaignWorkerTick();
      if (!tick.enabled) {
        if (tick.reason !== lastIdleReason) {
          console.info(`Campaign worker idle: ${tick.reason}`);
          lastIdleReason = tick.reason ?? "";
        }
      } else {
        lastIdleReason = "";
        if (tick.claimed > 0) {
          console.info("Campaign worker processed a batch", {
            claimed: tick.claimed,
            outcomes: tick.outcomes,
          });
        }
      }
    } catch {
      // No contact, token, provider payload, or raw database error is logged.
      console.error("Campaign worker tick failed; claimed sends require reconciliation.");
    }
    if (!stopping) await sleep(POLL_MS);
  }
}

void main();
