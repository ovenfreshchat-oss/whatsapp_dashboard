/**
 * Starts a sender run on Vercel. Safe to call repeatedly: a run exits at once when another run
 * holds the single-sender lease, and ends by itself when no campaign has work left.
 *
 * Off Vercel (local development) this does nothing: `npm run worker` is the sender there, and the
 * workflow transform is not applied locally (see next.config.ts).
 */
export async function startCampaignSendWorkflow(): Promise<boolean> {
  if (!process.env.VERCEL_DEPLOYMENT_ID) return false;
  const [{ start }, { campaignSendWorkflow }] = await Promise.all([
    import("workflow/api"),
    import("@/workflows/campaign-send"),
  ]);
  await start(campaignSendWorkflow, [crypto.randomUUID()]);
  return true;
}
