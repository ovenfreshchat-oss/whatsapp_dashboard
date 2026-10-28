import { redirect } from "next/navigation";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { getStaffReadSession } from "@/server/auth/staff-users/admin";

/**
 * One persistent frame for every dashboard screen. Pages render only their own content, so
 * moving between sections no longer rebuilds the sidebar or flashes a page-wide skeleton.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { access, email } = await getStaffReadSession();
  if (access === "signed-out") redirect("/sign-in");
  return <DashboardShell showMetaSetup={access === "allowed"} email={email}>{children}</DashboardShell>;
}
