import type { SupabaseClient } from "@supabase/supabase-js";
import { getWorkspaceRole } from "./admin";

export type StaffMember = { id: string; email: string; createdAt: string; lastSignInAt: string | null };

const PER_PAGE = 200;

/** Every staff account (app_metadata.role === "staff"), newest first. Admins are not listed. */
export async function listStaffMembers(admin: SupabaseClient): Promise<StaffMember[] | null> {
  const members: StaffMember[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) return null;
    for (const user of data.users) {
      if (getWorkspaceRole(user) !== "staff" || !user.email) continue;
      members.push({ id: user.id, email: user.email, createdAt: user.created_at, lastSignInAt: user.last_sign_in_at ?? null });
    }
    if (data.users.length < PER_PAGE) break;
  }
  return members.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
