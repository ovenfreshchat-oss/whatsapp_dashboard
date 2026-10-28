"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { useFeedback } from "@/components/ui/feedback";
import { deleteDraftCampaignAction } from "./actions";
import styles from "./campaigns.module.css";

/** Deleting a draft always asks first, then reports success or the exact error. */
export function DeleteDraftButton({ id, name, redirectTo, label = false }: {
  id: string;
  name: string;
  redirectTo?: string;
  label?: boolean;
}) {
  const router = useRouter();
  const { confirm, toast } = useFeedback();
  const [pending, start] = useTransition();

  async function onDelete() {
    const ok = await confirm({
      title: "Delete this draft?",
      description: <>The draft <strong>{name}</strong> and its recipient list will be permanently deleted. This cannot be undone. Contacts and uploads are not affected.</>,
      confirmLabel: "Delete draft",
      cancelLabel: "Keep draft",
      tone: "danger",
    });
    if (!ok) return;
    start(async () => {
      let message = "";
      try {
        message = (await deleteDraftCampaignAction(id)).error;
      } catch {
        message = "The draft could not be deleted. Check your connection and try again.";
      }
      if (message) {
        toast({ tone: "error", title: "Draft not deleted", message });
        return;
      }
      toast({ tone: "success", title: "Draft deleted", message: `“${name}” was removed.` });
      if (redirectTo) router.push(redirectTo); else router.refresh();
    });
  }

  return <button type="button" className={label ? styles.deleteText : styles.deleteIcon} onClick={onDelete} disabled={pending}
    aria-busy={pending || undefined} aria-label={`Delete draft ${name}`} title="Delete draft">
    {pending ? <Spinner size={18} /> : <Trash2 size={18} aria-hidden="true" />}{label && <span>{pending ? "Deleting…" : "Delete draft"}</span>}
  </button>;
}
