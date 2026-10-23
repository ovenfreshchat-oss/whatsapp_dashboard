"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

type SignInState = { error: string };

export async function signIn(
  _previousState: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const rawEmail = formData.get("email");
  const rawPassword = formData.get("password");

  if (
    typeof rawEmail !== "string" ||
    typeof rawPassword !== "string" ||
    rawEmail.length > 320 ||
    rawPassword.length > 1024 ||
    !rawEmail.trim() ||
    !rawPassword
  ) {
    return { error: "Enter your email address and password." };
  }

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email: rawEmail.trim(),
      password: rawPassword,
    });

    if (error) {
      return { error: "We couldn't sign you in. Check your email and password." };
    }
  } catch {
    return { error: "Sign-in is unavailable right now. Please try again." };
  }

  revalidatePath("/", "layout");
  redirect("/dashboard");
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut({ scope: "local" });

  if (error) {
    throw new Error("Unable to sign out right now.");
  }

  revalidatePath("/", "layout");
  redirect("/sign-in");
}
