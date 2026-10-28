"use client";

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { AlertTriangle, CheckCircle2, Info, TriangleAlert, X } from "lucide-react";
import { Spinner } from "./spinner";
import styles from "./feedback.module.css";

export type ToastTone = "success" | "error" | "info";
export type ToastInput = { tone: ToastTone; title: string; message?: string; duration?: number };
type Toast = ToastInput & { id: number };

export type ConfirmOptions = {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "default";
};

type Pending = ConfirmOptions & { resolve: (value: boolean) => void };

type FeedbackApi = {
  toast: (input: ToastInput) => number;
  dismiss: (id: number) => void;
  /** Opens the confirmation dialog and resolves true only when the user confirms. */
  confirm: (options: ConfirmOptions) => Promise<boolean>;
};

const noop: FeedbackApi = { toast: () => 0, dismiss: () => undefined, confirm: async () => false };
const FeedbackContext = createContext<FeedbackApi>(noop);

export function useFeedback(): FeedbackApi {
  return useContext(FeedbackContext);
}

const ICON = { success: CheckCircle2, error: TriangleAlert, info: Info } as const;

function ToastItem({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const [paused, setPaused] = useState(false);
  const Icon = ICON[toast.tone];
  const duration = toast.duration ?? (toast.tone === "error" ? 9000 : 5000);
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(onClose, duration);
    return () => clearTimeout(timer);
  }, [paused, duration, onClose]);
  return (
    <li
      className={[styles.toast, styles[toast.tone]].join(" ")}
      role={toast.tone === "error" ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <Icon size={20} aria-hidden="true" className={styles.toastIcon} />
      <div className={styles.toastBody}>
        <strong>{toast.title}</strong>
        {toast.message && <p>{toast.message}</p>}
      </div>
      <button type="button" className={styles.toastClose} onClick={onClose} aria-label="Dismiss message"><X size={16} aria-hidden="true" /></button>
    </li>
  );
}

function ConfirmDialog({ pending, onResolve }: { pending: Pending | null; onResolve: (value: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (pending && !dialog.open) {
      dialog.showModal();
      // The safe choice has focus first, so Enter never deletes by accident.
      cancelRef.current?.focus();
    }
    if (!pending && dialog.open) dialog.close();
  }, [pending]);

  const danger = pending?.tone === "danger";
  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby="confirm-title"
      aria-describedby="confirm-desc"
      onCancel={(event) => { event.preventDefault(); onResolve(false); }}
      onClick={(event) => { if (event.target === ref.current) onResolve(false); }}
    >
      {pending && (
        <div className={styles.dialogBody}>
          <span className={[styles.dialogIcon, danger ? styles.dialogIconDanger : ""].join(" ")} aria-hidden="true">
            <AlertTriangle size={22} />
          </span>
          <div className={styles.dialogText}>
            <h2 id="confirm-title">{pending.title}</h2>
            {pending.description && <div id="confirm-desc" className={styles.dialogDesc}>{pending.description}</div>}
          </div>
          <div className={styles.dialogActions}>
            <button ref={cancelRef} type="button" className={styles.dialogCancel} onClick={() => onResolve(false)}>{pending.cancelLabel ?? "Cancel"}</button>
            <button type="button" className={danger ? styles.dialogDanger : styles.dialogPrimary} onClick={() => onResolve(true)}>{pending.confirmLabel ?? "Confirm"}</button>
          </div>
        </div>
      )}
    </dialog>
  );
}

/** Mounted once in the dashboard layout: gives every screen toasts and a confirmation dialog. */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const counter = useRef(0);
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;

  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((item) => item.id !== id)), []);
  const toast = useCallback((input: ToastInput) => {
    counter.current += 1;
    const id = counter.current;
    setToasts((list) => [...list.slice(-3), { ...input, id }]);
    return id;
  }, []);
  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => {
    // A second request while one is open cancels the first, so no promise is left waiting.
    pendingRef.current?.resolve(false);
    setPending({ ...options, resolve });
  }), []);
  const resolve = useCallback((value: boolean) => {
    pendingRef.current?.resolve(value);
    setPending(null);
  }, []);

  const api = useMemo<FeedbackApi>(() => ({ toast, dismiss, confirm }), [toast, dismiss, confirm]);

  return (
    <FeedbackContext.Provider value={api}>
      {children}
      <ConfirmDialog pending={pending} onResolve={resolve} />
      <ol className={styles.toastRegion} aria-label="Notifications">
        {toasts.map((item) => <ToastItem key={item.id} toast={item} onClose={() => dismiss(item.id)} />)}
      </ol>
    </FeedbackContext.Provider>
  );
}

/** Shows a toast whenever a server action returns a new `{ error, success }` result. */
export function useActionToast(
  state: { error?: string; success?: string } | null | undefined,
  titles: { success?: string; error?: string } = {},
) {
  const { toast } = useFeedback();
  const first = useRef(true);
  const last = useRef(state);
  useEffect(() => {
    if (first.current) { first.current = false; last.current = state; return; }
    if (state === last.current || !state) return;
    last.current = state;
    if (state.error) toast({ tone: "error", title: titles.error ?? "That did not work", message: state.error });
    else if (state.success) toast({ tone: "success", title: titles.success ?? "Done", message: state.success });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
}

/** Inline "Working…" row for slow operations that do not have a button of their own. */
export function Working({ children }: { children: ReactNode }) {
  return <p className={styles.working} role="status"><Spinner />{children}</p>;
}
