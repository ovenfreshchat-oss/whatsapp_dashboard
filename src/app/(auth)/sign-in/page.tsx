"use client";

import { useActionState, useState } from "react";
import { Brand } from "@/components/layout/brand";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { TextField } from "@/components/ui/text-field";
import { signIn } from "@/server/auth/actions";
import styles from "./sign-in.module.css";

function ArrowIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M3.5 10h12m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="2.5" y="4" width="15" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="m3.6 5.2 6.4 5 6.4-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="4" y="8.5" width="12" height="9" rx="2.3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6.6 8.5V6.4a3.4 3.4 0 0 1 6.8 0v2.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export default function SignInPage() {
  const [state, formAction, pending] = useActionState(signIn, { error: "" });
  const [email, setEmail] = useState("");

  return (
    <main className={styles.page}>
      <div className={styles.haloOne} aria-hidden="true" />
      <div className={styles.haloTwo} aria-hidden="true" />

      <section className={styles.shell} aria-label="Solalyn staff sign-in">
        <div className={styles.storyPanel}>
          <div className={styles.storyGlow} aria-hidden="true" />
          <header className={styles.brand}>
            <Brand />
          </header>

          <div className={styles.storyCopy}>
            <span className={styles.eyebrow}><span className={styles.eyebrowDot} /> A NEW WAY TO STAY CONNECTED</span>
            <h1>Every conversation.<br /><em>One connected workspace.</em></h1>
            <p>A smarter way to manage customer conversations, automate communication, and build stronger business relationships through WhatsApp.</p>
            <p>From everyday messages to automated workflows, bring your customer communication together in one place.</p>
          </div>

          <div className={styles.previewStage} aria-hidden="true">
            <div className={styles.previewOrbit} />
            <div className={styles.previewCard}>
              <div className={styles.previewTop}>
                <div className={styles.previewWindowDots}><i /><i /><i /></div>
                <span>Workspace preview</span>
                <span className={styles.previewSparkle}>✦</span>
              </div>
              <div className={styles.previewBody}>
                <div className={styles.previewHeading}>
                  <span className={styles.previewHeadingIcon}>✳</span>
                  <div><strong>Your next campaign</strong><small>Everything in one place</small></div>
                </div>
                <div className={styles.previewSteps}>
                  <div className={styles.previewStep}><span className={styles.stepIcon}>01</span><span>Contacts</span><span className={styles.stepLine} /></div>
                  <div className={styles.previewStep}><span className={styles.stepIcon}>02</span><span>Templates</span><span className={styles.stepLine} /></div>
                  <div className={styles.previewStep}><span className={styles.stepIcon}>03</span><span>Campaigns</span><span className={styles.stepLine} /></div>
                </div>
              </div>
            </div>
            <div className={styles.floatingNote}><span>✦</span><div><strong>Made for meaningful outreach</strong><small>Simple. Considered. Connected.</small></div></div>
          </div>

          <footer className={styles.storyFooter}><span>THE OVEN FRESH · CANADA</span><span className={styles.footerLine} /><span>01 / 03</span></footer>
        </div>

        <div className={styles.formPanel}>
          <header className={styles.formHeader}>
            <StatusBadge>PRIVATE WORKSPACE</StatusBadge>
            <span className={styles.headerCross} aria-hidden="true">✧</span>
          </header>

          <div className={styles.formContent}>
            <div className={styles.mobileBrand}><Brand compact /></div>
            <span className={styles.sectionLabel}>STAFF PORTAL</span>
            <h2>Welcome<br /><span>back.</span></h2>
            <p className={styles.formIntro}>Sign in to continue to your campaign workspace.</p>

            <form className={styles.form} action={formAction}>
              <TextField id="email" name="email" label="Email address" type="email" placeholder="you@company.com" autoComplete="email" leadingIcon={<MailIcon />} required value={email} onChange={(event) => setEmail(event.target.value)} aria-invalid={Boolean(state.error)} aria-describedby={state.error ? "sign-in-error" : undefined} />
              <TextField id="password" name="password" label="Password" type="password" placeholder="Enter your password" autoComplete="current-password" leadingIcon={<LockIcon />} required aria-invalid={Boolean(state.error)} aria-describedby={state.error ? "sign-in-error" : undefined} />
              {state.error && <p className={styles.errorText} id="sign-in-error" role="alert">{state.error}</p>}
              <Button type="submit" disabled={pending} trailingIcon={<ArrowIcon />}>{pending ? "Signing in…" : "Sign in"}</Button>
            </form>
          </div>

          <footer className={styles.formFooter}><span>© 2026 Solalyn</span><span>Staff access only <span aria-hidden="true">↗</span></span></footer>
        </div>
      </section>
    </main>
  );
}
