import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { cache } from "react";
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

/**
 * Read-only access check for page renders and polling. It verifies the signed session JWT
 * locally (no Supabase Auth round trip, the proxy already refreshed the cookie), so it is
 * much faster than getStaffAdminAccess(). Anything that sends, writes or changes data must
 * keep using getStaffAdminAccess(), which asks Supabase Auth and honours revoked sessions.
 */
export type StaffReadSession = { access: StaffAdminAccess; email: string | null; isStaff: boolean };

/** Same local check as getStaffReadAccess, but also returns the signed-in email for display. */
export const getStaffReadSession = cache(async (): Promise<StaffReadSession> => {
  const supabase = await createSessionClient();
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims) return { access: "signed-out", email: null, isStaff: false };
  const email = typeof claims.email === "string" ? claims.email : undefined;
  const isStaff = (claims.app_metadata as { role?: unknown } | undefined)?.role === "staff";
  return { access: isStaffAdminEmail(email) ? "allowed" : "forbidden", email: email ?? null, isStaff };
});

export const getStaffReadAccess = cache(async (): Promise<StaffAdminAccess> => (await getStaffReadSession()).access);

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
