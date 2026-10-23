"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createStaffAdminClient, getStaffAdminAccess } from "@/server/auth/staff-users/admin";
import { parseOptOutInput } from "@/server/opt-outs/parse";

export type OptOutState = { error: string; success: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_INPUT_CHARS = 200_000;

async function adminActor() {
  if (await getStaffAdminAccess() !== "allowed") return null;
  const session = await createClient();
  const { data, error } = await session.auth.getUser();
  const admin = createStaffAdminClient();
  if (error || !data.user || !admin) return null;
  return { admin, userId: data.user.id };
}

export async function addOptOutNumbers(_previous: OptOutState, form: FormData): Promise<OptOutState> {
  const numbers = form.get("numbers");
  const source = form.get("source");
  const country = form.get("defaultCountry");
  if (typeof numbers !== "string" || !numbers.trim() || numbers.length > MAX_INPUT_CHARS ||
      typeof source !== "string" || !source.trim() || source.trim().length > 200 ||
      (country !== null && typeof country !== "string")) {
    return { error: "Enter at least one number and a source (up to 200 characters).", success: "" };
  }
  const parsed = parseOptOutInput(numbers, country?.trim() || undefined);
  if (parsed.tooMany) return { error: "Add at most 5000 numbers at a time.", success: "" };
  if (!parsed.numbers.length) {
    const first = parsed.rejected[0];
    return {
      error: first ? `No valid numbers. Line ${first.line} "${first.value}": ${first.message}` : "No numbers found.",
      success: "",
    };
  }
  const actor = await adminActor();
  if (!actor) return { error: "Only a signed-in workspace admin can change the opt-out list.", success: "" };

  const { data, error } = await actor.admin.rpc("add_opt_out_numbers", {
    p_phones: parsed.numbers,
    p_source: source.trim(),
    p_actor_user_id: actor.userId,
  });
  if (error) {
    return { error: "The numbers could not be saved. Check that drizzle/0010_opt_out_numbers.sql is applied.", success: "" };
  }
  revalidatePath("/dashboard/opt-outs");
  const result = (data ?? {}) as { added?: number; reactivated?: number; already_listed?: number };
  const rejectedNote = parsed.rejected.length
    ? ` ${parsed.rejected.length} rejected (first: line ${parsed.rejected[0].line} "${parsed.rejected[0].value}" — ${parsed.rejected[0].message})`
    : "";
  return {
    error: "",
    success: `${result.added ?? 0} added, ${result.reactivated ?? 0} re-activated, ${result.already_listed ?? 0} already listed, ${parsed.duplicates} duplicate in input.${rejectedNote}`,
  };
}

export async function releaseOptOutNumber(_previous: OptOutState, form: FormData): Promise<OptOutState> {
  const id = form.get("id");
  if (typeof id !== "string" || !UUID.test(id)) return { error: "Invalid entry.", success: "" };
  const actor = await adminActor();
  if (!actor) return { error: "Only a signed-in workspace admin can change the opt-out list.", success: "" };
  const { error } = await actor.admin.rpc("release_opt_out_number", { p_id: id, p_actor_user_id: actor.userId });
  if (error) return { error: "The number could not be removed.", success: "" };
  revalidatePath("/dashboard/opt-outs");
  return { error: "", success: "Removed from the opt-out list." };
}
