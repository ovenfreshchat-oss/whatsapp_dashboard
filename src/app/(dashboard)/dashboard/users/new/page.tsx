import type { Metadata } from "next";
import { BackLink } from "@/components/ui/back-link";
import { StaffUserForm } from "./staff-user-form";
import styles from "./new-user.module.css";

export const metadata: Metadata = {
  title: "Add staff user | Solalyn",
};

export default function NewStaffUserPage() {
  const isConfigured = Boolean(process.env.SUPABASE_SECRET_KEY);

  return (
    <>
        <div className={styles.content}>
          <BackLink href="/dashboard">Back to dashboard</BackLink>

          <div className={styles.intro}>
            <span className={styles.eyebrow}>TEAM ACCESS / NEW USER</span>
            <h1>Add a staff user<span>.</span></h1>
            <p>Create an account directly so your teammate can sign in to the workspace.</p>
          </div>

          <div className={styles.columns}>
            <section className={styles.formCard} aria-labelledby="account-details-heading">
              <div className={styles.cardHeader}>
                <span className={styles.cardIcon} aria-hidden="true">✳</span>
                <div>
                  <span className={styles.cardEyebrow}>ACCOUNT DETAILS</span>
                  <h2 id="account-details-heading">New staff account</h2>
                </div>
              </div>
              {isConfigured ? (
                <StaffUserForm />
              ) : (
                <p className={styles.setupMessage} role="status">
                  Add SUPABASE_SECRET_KEY to the server environment, then restart the app to enable account creation.
                </p>
              )}
            </section>

            <aside className={styles.infoCard} aria-label="How direct account creation works">
              <div className={styles.infoGlow} aria-hidden="true" />
              <span className={styles.infoLabel}>DIRECT ACCESS</span>
              <h2>Ready when<br /><em>they are.</em></h2>
              <p>Staff can send campaigns, add and import contacts, manage opt-outs and reply in the inbox. Team, WhatsApp setup and templates stay admin-only.</p>
              <div className={styles.infoDivider} />
              <ul className={styles.infoList}>
                <li><span>01</span><div><strong>Create the account</strong><small>Use their work email address.</small></div></li>
                <li><span>02</span><div><strong>Share credentials privately</strong><small>No invitation email is sent from this form.</small></div></li>
                <li><span>03</span><div><strong>Sign in</strong><small>They can open the staff login page.</small></div></li>
              </ul>
              <div className={styles.infoFooter}><span aria-hidden="true">✦</span> Solalyn workspace</div>
            </aside>
          </div>
        </div>
    </>
  );
}
