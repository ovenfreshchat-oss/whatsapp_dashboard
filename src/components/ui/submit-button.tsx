"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Spinner } from "./spinner";
import styles from "./ui.module.css";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & {
  pendingLabel?: ReactNode;
  variant?: "primary" | "secondary" | "danger";
  size?: "md" | "sm";
  /** Pending state driven by the caller (for example a `useTransition`), in addition to the form's own. */
  pending?: boolean;
};

const VARIANT = { primary: styles.btnPrimary, secondary: styles.btnSecondary, danger: styles.btnDanger } as const;

/**
 * A submit button that shows a spinner and disables itself while its form is being processed,
 * so a second tap can never send the same request twice.
 */
export function SubmitButton({ children, pendingLabel, variant = "primary", size = "md", pending: external = false, className = "", disabled, ...rest }: Props) {
  const status = useFormStatus();
  const pending = status.pending || external;
  return (
    <button
      type="submit"
      {...rest}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={[styles.btn, VARIANT[variant], size === "sm" ? styles.btnSm : "", className].filter(Boolean).join(" ")}
    >
      {pending && <Spinner />}
      <span>{pending && pendingLabel ? pendingLabel : children}</span>
    </button>
  );
}
