import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { cache } from "react";
import { createClient as createSessionClient } from "@/lib/supabase/server";
import { parseAdminEmails, resolveWorkspaceRole, type WorkspaceRole } from "./roles";

export type { WorkspaceRole };

export type StaffAdminAccess = "allowed" | "signed-out" | "forbidden";

function adminEmails() {
  return parseAdminEmails(process.env.STAFF_ADMIN_EMAILS);
}

/** Role for a Supabase user (admin from STAFF_ADMIN_EMAILS, staff from app_metadata). */
export function getWorkspaceRole(user: { email?: string | null; app_metadata?: unknown }): WorkspaceRole | null {
  return resolveWorkspaceRole(user.email, user.app_metadata, adminEmails());
}

/**
 * Write-safe access for day-to-day work (campaigns, contacts, inbox, opt-outs): admins AND
 * staff created from the Team page. Asks Supabase Auth, so banned or deleted users are
 * refused immediately. Admin-only actions (team, WhatsApp setup, templates) keep using
 * getStaffAdminAccess().
 */
export async function getWorkspaceAccess(): Promise<StaffAdminAccess> {
  const supabase = await createSessionClient();
  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user) return "signed-out";
  if (!data.user.email_confirmed_at || !getWorkspaceRole(data.user)) return "forbidden";

  return "allowed";
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
export type StaffReadSession = {
  /** Admin-only access (STAFF_ADMIN_EMAILS). */
  access: StaffAdminAccess;
  /** Admin OR staff: may work in campaigns, contacts, inbox and opt-outs. */
  workspaceAccess: StaffAdminAccess;
  role: WorkspaceRole | null;
  email: string | null;
  isStaff: boolean;
};

/** Same local check as getStaffReadAccess, but also returns the signed-in email for display. */
export const getStaffReadSession = cache(async (): Promise<StaffReadSession> => {
  const supabase = await createSessionClient();
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims) return { access: "signed-out", workspaceAccess: "signed-out", role: null, email: null, isStaff: false };
  const email = typeof claims.email === "string" ? claims.email : undefined;
  const isStaff = (claims.app_metadata as { role?: unknown } | undefined)?.role === "staff";
  const role = resolveWorkspaceRole(email, claims.app_metadata, adminEmails());
  return {
    access: isStaffAdminEmail(email) ? "allowed" : "forbidden",
    workspaceAccess: role ? "allowed" : "forbidden",
    role,
    email: email ?? null,
    isStaff,
  };
});

export const getStaffReadAccess = cache(async (): Promise<StaffAdminAccess> => (await getStaffReadSession()).access);

/** Read-only check for admin OR staff pages (campaigns, contacts, inbox, opt-outs, templates). */
export const getWorkspaceReadAccess = cache(async (): Promise<StaffAdminAccess> => (await getStaffReadSession()).workspaceAccess);

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
