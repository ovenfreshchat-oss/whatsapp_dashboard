import { withWorkflow } from "workflow/next";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pulled in through @workflow/world-vercel; webpack bundling breaks its app-name detection.
  serverExternalPackages: ["xdg-app-paths"],
  // Campaign header images are uploaded through a server action (Vercel caps requests at 4.5 MB).
  async headers() {
    return [{ source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }] }];
  },
  experimental: { serverActions: { bodySizeLimit: "5mb" } },
};

// The workflow transform is applied on Vercel only. Locally `npm run worker` is the sender, and
// the local workflow world can crash Next's build (same approach as the summaryz project).
export default process.env.VERCEL_DEPLOYMENT_ID ? withWorkflow(nextConfig) : nextConfig;
