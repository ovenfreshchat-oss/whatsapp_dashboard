import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./button.module.css";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary";
  trailingIcon?: ReactNode;
};

export function Button({ variant = "primary", trailingIcon, className = "", children, ...props }: ButtonProps) {
  return (
    <button className={[styles.button, styles[variant], className].filter(Boolean).join(" ")} {...props}>
      <span>{children}</span>
      {trailingIcon}
    </button>
  );
}
