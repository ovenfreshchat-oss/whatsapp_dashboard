import { createStaffAdminClient } from "@/server/auth/staff-users/admin";

const TABLE = "dashboard_meta_snapshots";
const KEEP_MS = 45 * 86_400_000;

export type Snapshotted<T> = { value: T | null; /** ISO time of the stored value when Meta could not be reached, otherwise null. */ asOf: string | null };

/**
 * Runs `fetch` (a Meta call that returns null when Meta cannot answer). A good answer is stored and returned.
 * When Meta fails, the last stored answer is returned with its time, so a number never jumps to another source.
 * Never throws: storage problems only mean there is no fallback.
 */
export async function withSnapshot<T>(key: string, fetch: () => Promise<T | null>): Promise<Snapshotted<T>> {
  let fresh: T | null = null;
  try { fresh = await fetch(); } catch { fresh = null; }
  const admin = createStaffAdminClient();
  if (fresh !== null) {
    if (admin) {
      try {
        await admin.from(TABLE).upsert({ key, value: fresh as unknown as Record<string, unknown>, fetched_at: new Date().toISOString() });
        await admin.from(TABLE).delete().lt("fetched_at", new Date(Date.now() - KEEP_MS).toISOString());
      } catch { /* the fresh value is still shown */ }
    }
    return { value: fresh, asOf: null };
  }
  if (!admin) return { value: null, asOf: null };
  try {
    const { data, error } = await admin.from(TABLE).select("value,fetched_at").eq("key", key).maybeSingle();
    if (error || !data) return { value: null, asOf: null };
    return { value: data.value as T, asOf: String(data.fetched_at) };
  } catch {
    return { value: null, asOf: null };
  }
}
