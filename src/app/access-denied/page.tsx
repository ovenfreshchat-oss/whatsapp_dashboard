import type { Metadata } from "next";
import { Brand } from "@/components/layout/brand";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { signOut } from "@/server/auth/actions";
import styles from "./access-denied.module.css";

export const metadata: Metadata = {
  title: "Access unavailable | Solalyn",
};

export default function AccessDeniedPage() {
  return (
    <main className={styles.page}>
      <section className={styles.shell} aria-labelledby="access-heading">
        <header className={styles.header}>
          <Brand />
          <StatusBadge>PRIVATE WORKSPACE</StatusBadge>
        </header>

        <div className={styles.content}>
          <div className={styles.icon} aria-hidden="true">✧</div>
          <span className={styles.eyebrow}>ACCESS UNAVAILABLE</span>
          <h1 id="access-heading">This workspace isn&apos;t available to your account.</h1>
          <p>
            If you should have access, ask your workspace admin to add your account.
            You can also sign out and use a different account.
          </p>
          <form action={signOut} className={styles.signOutForm}>
            <Button type="submit">Sign out</Button>
          </form>
        </div>

        <footer className={styles.footer}>Solalyn · Staff access</footer>
      </section>
    </main>
  );
}
