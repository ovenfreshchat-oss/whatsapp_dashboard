"use server";

import { createStaffAdminClient, getStaffAdminAccess } from "./admin";

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

  const email = rawEmail.trim();
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

  return { error: "", success: `Account created for ${email}. They can sign in now.` };
}
