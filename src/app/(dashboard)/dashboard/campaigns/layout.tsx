import { redirect } from "next/navigation";
import { getStaffAdminAccess } from "@/server/auth/staff-users/admin";

export default async function CampaignsLayout({ children }: { children: React.ReactNode }) {
  const access = await getStaffAdminAccess();
  if (access === "signed-out") redirect("/sign-in");
  if (access !== "allowed") redirect("/access-denied");
  return children;
}
