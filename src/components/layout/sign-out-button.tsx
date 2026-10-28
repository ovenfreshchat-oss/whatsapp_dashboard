"use client";

import { LogOut } from "lucide-react";
import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import styles from "./dashboard-shell.module.css";

export function SignOutButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={styles.signOut} disabled={pending} aria-label="Sign out" title="Sign out">
      {pending ? <Loader2 size={18} className={styles.navSpin} aria-hidden="true" /> : <LogOut size={18} strokeWidth={2} aria-hidden="true" />}
      <span className={styles.signOutLabel}>{pending ? "Signing out…" : "Sign out"}</span>
    </button>
  );
}
