export type WorkspaceRole = "admin" | "staff";

/** Emails listed in STAFF_ADMIN_EMAILS (comma-separated) are workspace admins. */
export function parseAdminEmails(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Admin = email in STAFF_ADMIN_EMAILS. Staff = account created from the Team page, marked
 * app_metadata.role === "staff". app_metadata can only be written with the service key, so a
 * user can never grant themselves a role. Anything else has no workspace access.
 */
export function resolveWorkspaceRole(
  email: string | undefined | null,
  appMetadata: unknown,
  adminEmails: Set<string>,
): WorkspaceRole | null {
  if (email && adminEmails.has(email.trim().toLowerCase())) return "admin";
  const role = (appMetadata as { role?: unknown } | null | undefined)?.role;
  return role === "staff" ? "staff" : null;
}
