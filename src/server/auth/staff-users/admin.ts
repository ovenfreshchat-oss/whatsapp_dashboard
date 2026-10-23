import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient as createSessionClient } from "@/lib/supabase/server";

export type StaffAdminAccess = "allowed" | "signed-out" | "forbidden";

function adminEmails() {
  return new Set(
    (process.env.STAFF_ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isStaffAdminEmail(email: string | undefined): boolean {
  return Boolean(email && adminEmails().has(email.trim().toLowerCase()));
}

export async function getStaffAdminAccess(): Promise<StaffAdminAccess> {
  const supabase = await createSessionClient();
  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user) return "signed-out";
  if (!data.user.email_confirmed_at || !isStaffAdminEmail(data.user.email)) {
    return "forbidden";
  }

  return "allowed";
}

export function createStaffAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) return null;

  return createSupabaseClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}
