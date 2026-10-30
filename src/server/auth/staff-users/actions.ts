"use server";

import { revalidatePath } from "next/cache";
import { createStaffAdminClient, getStaffAdminAccess, getWorkspaceRole } from "./admin";
import { MAX_STAFF_USERS, STAFF_LIMIT_MESSAGE } from "./limits";
import { listStaffMembers } from "./list";

export type CreateStaffUserState = { error: string; success: string };

export async function createStaffUser(
  _previousState: CreateStaffUserState,
  formData: FormData,
): Promise<CreateStaffUserState> {
  const access = await getStaffAdminAccess();
  if (access !== "allowed") {
    return { error: "You do not have permission to add staff users.", success: "" };
  }

  const rawEmail = formData.get("email");
  const password = formData.get("password");
  const confirmation = formData.get("confirmPassword");

  if (
    typeof rawEmail !== "string" ||
    typeof password !== "string" ||
    typeof confirmation !== "string"
  ) {
    return { error: "Enter an email address and matching passwords.", success: "" };
  }

  const email = rawEmail.trim().toLowerCase();
  if (
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    password.length < 8 ||
    password.length > 128 ||
    password !== confirmation
  ) {
    return { error: "Enter a valid email and matching passwords of 8–128 characters.", success: "" };
  }

  const admin = createStaffAdminClient();
  if (!admin) {
    return { error: "Account creation is not configured. Add SUPABASE_SECRET_KEY to the server environment.", success: "" };
  }

  const existing = await listStaffMembers(admin);
  if (!existing) {
    return { error: "Could not check the current team. Please try again.", success: "" };
  }
  if (existing.length >= MAX_STAFF_USERS) {
    return { error: STAFF_LIMIT_MESSAGE, success: "" };
  }

  try {
    const { error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { role: "staff" },
    });

    if (error) {
      if (error.code === "email_exists" || error.message.toLowerCase().includes("already registered")) {
        return { error: "An account with this email already exists.", success: "" };
      }
      if (error.status === 401 || error.status === 403) {
        return { error: "The Supabase admin key cannot create users. Check SUPABASE_SECRET_KEY.", success: "" };
      }
      return { error: "Unable to create the account. Check your project's password rules and try again.", success: "" };
    }
  } catch {
    return { error: "Account creation is unavailable right now. Please try again.", success: "" };
  }

  revalidatePath("/dashboard/users/new");
  return { error: "", success: `Account created for ${email}. They can sign in now.` };
}

export type DeleteStaffUserState = { error: string };

/** Deletes a staff account. Only admins can; admin accounts can never be deleted from here. */
export async function deleteStaffUser(userId: string): Promise<DeleteStaffUserState> {
  const access = await getStaffAdminAccess();
  if (access !== "allowed") return { error: "You do not have permission to delete staff users." };
  if (typeof userId !== "string" || !/^[0-9a-f-]{36}$/i.test(userId)) return { error: "That user could not be found." };

  const admin = createStaffAdminClient();
  if (!admin) return { error: "Account management is not configured. Add SUPABASE_SECRET_KEY to the server environment." };

  try {
    const { data, error: lookupError } = await admin.auth.admin.getUserById(userId);
    if (lookupError || !data.user) return { error: "That user could not be found. Refresh the page." };
    if (getWorkspaceRole(data.user) !== "staff") return { error: "Only staff accounts can be deleted here." };

    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) return { error: "Unable to delete the account. Please try again." };
  } catch {
    return { error: "Account deletion is unavailable right now. Please try again." };
  }

  revalidatePath("/dashboard/users/new");
  return { error: "" };
}
