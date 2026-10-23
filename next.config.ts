import { withWorkflow } from "workflow/next";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pulled in through @workflow/world-vercel; webpack bundling breaks its app-name detection.
  serverExternalPackages: ["xdg-app-paths"],
};

// The workflow transform is applied on Vercel only. Locally `npm run worker` is the sender, and
// the local workflow world can crash Next's build (same approach as the summaryz project).
export default process.env.VERCEL_DEPLOYMENT_ID ? withWorkflow(nextConfig) : nextConfig;
