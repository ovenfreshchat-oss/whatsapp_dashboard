"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { saveMetricAdjustments } from "./actions";
import styles from "./adjust.module.css";

export type AdjustRow = { metric: string; label: string; counted: number; current: number; hint?: string };

export function AdjustForm({ rows }: { rows: AdjustRow[] }) {
  const [state, formAction, pending] = useActionState(saveMetricAdjustments, { error: "", success: "" });
  return (
    <form action={formAction} className={styles.form}>
      {rows.map((row) => (
        <div key={row.metric} className={styles.row}>
          <div className={styles.rowText}>
            <strong>{row.label}</strong>
            <small>Dashboard counted {row.counted.toLocaleString("en-US")}{row.hint ? ` · ${row.hint}` : ""}</small>
          </div>
          <TextField
            id={`adjust-${row.metric}`}
            name={row.metric}
            label="Total per Meta"
            inputMode="numeric"
            autoComplete="off"
            placeholder="Leave empty for no change"
            defaultValue={row.current > row.counted ? String(row.current) : ""}
            maxLength={12}
          />
        </div>
      ))}
      {state.error && <p className={styles.error} role="alert">{state.error}</p>}
      {state.success && !pending && !state.error && <p className={styles.success} role="status">{state.success}</p>}
      <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save totals"}</Button>
    </form>
  );
}
