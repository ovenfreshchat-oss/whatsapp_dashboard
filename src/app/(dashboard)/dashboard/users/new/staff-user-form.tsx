"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { createStaffUser } from "@/server/auth/staff-users/actions";
import styles from "./new-user.module.css";

export function StaffUserForm() {
  const [state, formAction, pending] = useActionState(createStaffUser, { error: "", success: "" });
  const [email, setEmail] = useState("");
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!pending && state.success) {
      formRef.current?.reset();
      setEmail("");
    }
  }, [pending, state.success]);

  return (
    <form className={styles.form} ref={formRef} action={formAction}>
      <TextField
        id="staff-email"
        name="email"
        label="Work email address"
        type="email"
        placeholder="teammate@company.com"
        autoComplete="off"
        required
        maxLength={320}
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        aria-invalid={Boolean(state.error)}
        aria-describedby={state.error ? "staff-user-error" : undefined}
      />
      <div className={styles.passwordFields}>
        <TextField
          id="staff-password"
          name="password"
          label="Password"
          type="password"
          placeholder="At least 8 characters"
          autoComplete="new-password"
          required
          minLength={8}
          maxLength={128}
          aria-invalid={Boolean(state.error)}
          aria-describedby={state.error ? "staff-user-error" : "password-hint"}
        />
        <TextField
          id="staff-confirm-password"
          name="confirmPassword"
          label="Confirm password"
          type="password"
          placeholder="Repeat the password"
          autoComplete="new-password"
          required
          minLength={8}
          maxLength={128}
          aria-invalid={Boolean(state.error)}
          aria-describedby={state.error ? "staff-user-error" : undefined}
        />
      </div>
      <p className={styles.fieldHint} id="password-hint">Use a unique password with at least 8 characters.</p>
      {state.error && <p className={styles.errorMessage} id="staff-user-error" role="alert">{state.error}</p>}
      {state.success && !pending && !state.error && <p className={styles.successMessage} role="status">{state.success}</p>}
      <Button type="submit" disabled={pending}>
        {pending ? "Creating account…" : "Create staff account"}
      </Button>
    </form>
  );
}
