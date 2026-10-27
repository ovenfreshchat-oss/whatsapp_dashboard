import { redirect } from "next/navigation";
import { getStaffReadAccess } from "@/server/auth/staff-users/admin";

export default async function ContactsLayout({ children }: { children: React.ReactNode }) {
  const access = await getStaffReadAccess();
  if (access === "signed-out") redirect("/sign-in");
  if (access !== "allowed") redirect("/access-denied");
  return children;
}
