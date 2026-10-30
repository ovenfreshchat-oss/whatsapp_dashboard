"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { useFeedback } from "@/components/ui/feedback";
import { deleteStaffUser } from "@/server/auth/staff-users/actions";
import styles from "./new-user.module.css";

export type TeamMemberRow = { id: string; email: string; addedOn: string; lastSignIn: string };

export function TeamMembers({ members, max }: { members: TeamMemberRow[]; max: number }) {
  const router = useRouter();
  const { confirm, toast } = useFeedback();
  const [pending, start] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function onDelete(member: TeamMemberRow) {
    const ok = await confirm({
      title: "Delete this team member?",
      description: <><strong>{member.email}</strong> will be signed out and can no longer open the workspace. This cannot be undone.</>,
      confirmLabel: "Delete user",
      cancelLabel: "Keep user",
      tone: "danger",
    });
    if (!ok) return;
    setBusyId(member.id);
    start(async () => {
      let message = "";
      try {
        message = (await deleteStaffUser(member.id)).error;
      } catch {
        message = "The user could not be deleted. Check your connection and try again.";
      }
      setBusyId(null);
      if (message) {
        toast({ tone: "error", title: "User not deleted", message });
        return;
      }
      toast({ tone: "success", title: "User deleted", message: `${member.email} was removed.` });
      router.refresh();
    });
  }

  return (
    <section className={styles.listCard} aria-labelledby="team-members-heading">
      <div className={styles.listHeader}>
        <div>
          <span className={styles.cardEyebrow}>TEAM MEMBERS</span>
          <h2 id="team-members-heading">Staff users</h2>
        </div>
        <span className={styles.countPill} aria-label={`${members.length} of ${max} staff users`}>{members.length} / {max}</span>
      </div>
      {members.length === 0 ? (
        <p className={styles.emptyList}>No staff users yet. Add the first one below.</p>
      ) : (
        <ul className={styles.memberList}>
          {members.map((member) => (
            <li key={member.id} className={styles.memberRow}>
              <div className={styles.memberInfo}>
                <strong>{member.email}</strong>
                <small>Added {member.addedOn} · Last sign-in {member.lastSignIn}</small>
              </div>
              <button type="button" className={styles.deleteButton} onClick={() => onDelete(member)} disabled={pending}
                aria-busy={busyId === member.id || undefined} aria-label={`Delete ${member.email}`} title="Delete user">
                {busyId === member.id ? <Spinner size={16} /> : <Trash2 size={16} aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
