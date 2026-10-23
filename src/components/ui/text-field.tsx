import type { ComponentProps, ReactNode } from "react";
import styles from "./text-field.module.css";

type TextFieldProps = Omit<ComponentProps<"input">, "id"> & {
  id: string;
  label: string;
  leadingIcon?: ReactNode;
};

export function TextField({ id, label, leadingIcon, ...inputProps }: TextFieldProps) {
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      <div className={styles.inputShell}>
        {leadingIcon}
        <input id={id} {...inputProps} />
      </div>
    </div>
  );
}
