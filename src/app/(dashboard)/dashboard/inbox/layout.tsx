import { redirect } from "next/navigation";
import { getWorkspaceReadAccess } from "@/server/auth/staff-users/admin";

export default async function InboxLayout({ children }: { children: React.ReactNode }) {
  const access = await getWorkspaceReadAccess();
  if (access === "signed-out") redirect("/sign-in");
  if (access !== "allowed") redirect("/access-denied");
  return children;
}
