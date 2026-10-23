import { createClient } from "@supabase/supabase-js";

function readHidden(label) {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Run this command in an interactive terminal to enter the password privately.");
  }

  process.stdout.write(`${label}: `);

  return new Promise((resolve, reject) => {
    let value = "";
    let finished = false;
    const wasRaw = input.isRaw === true;

    function finish(error) {
      if (finished) return;
      finished = true;
      input.off("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    }

    function onData(chunk) {
      for (const character of chunk.toString("utf8")) {
        if (finished) return;
        if (character === "\r" || character === "\n") finish();
        else if (character === "\u0003") finish(new Error("Cancelled."));
        else if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    }

    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function main() {
  const resetExisting = process.argv.includes("--reset");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  const adminEmail = process.env.STAFF_ADMIN_EMAILS?.split(",")[0]?.trim().toLowerCase();

  if (!url || !secretKey || !adminEmail) {
    throw new Error("Set NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, and STAFF_ADMIN_EMAILS in .env first.");
  }
  if (!secretKey.startsWith("sb_secret_")) {
    throw new Error("SUPABASE_SECRET_KEY must be a Supabase secret API key (sb_secret_...).");
  }

  const supabase = createClient(url, secretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

  let existingUser;
  for (let page = 1; ; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error("Unable to check the admin account. Check the secret key and network connection.");
    existingUser = data.users.find((user) => user.email?.toLowerCase() === adminEmail);
    if (existingUser || data.users.length < 1000) break;
  }

  if (resetExisting && !existingUser) {
    throw new Error("The admin account does not exist yet. Run npm run bootstrap:admin first.");
  }
  if (!resetExisting && existingUser) {
    throw new Error("This admin account already exists. Sign in with its current password or run npm run reset:admin to set a new one.");
  }

  process.stdout.write(`${resetExisting ? "Set a new password for" : "Create the first admin account for"} ${adminEmail}.\n`);
  const password = await readHidden("New password");
  const confirmation = await readHidden("Confirm password");
  if (password.length < 8 || password.length > 128 || password !== confirmation) {
    throw new Error("Passwords must match and contain 8–128 characters.");
  }

  if (resetExisting) {
    const { error } = await supabase.auth.admin.updateUserById(existingUser.id, { password });
    if (error) throw new Error(`Supabase could not update the admin password (${error.status ?? "unknown status"}).`);
    process.stdout.write("Admin password updated. Sign in through /sign-in with the new password.\n");
    return;
  }

  const { error } = await supabase.auth.admin.createUser({
    email: adminEmail,
    password,
    email_confirm: true,
    app_metadata: { role: "staff" },
  });

  if (error) {
    if (error.code === "email_exists" || error.message.toLowerCase().includes("already registered")) {
      throw new Error("This admin email already has an Auth account. Sign in with it or run npm run reset:admin.");
    }
    throw new Error(`Supabase could not create the admin account (${error.status ?? "unknown status"}). Check the secret key and Auth settings.`);
  }

  process.stdout.write("Admin account created. Sign in through /sign-in with the new password.\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Unable to create admin account."}\n`);
  process.exitCode = 1;
});
