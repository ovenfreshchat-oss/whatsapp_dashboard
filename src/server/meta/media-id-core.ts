/**
 * Chooses how a campaign header file is sent: by WhatsApp media ID (uploaded once, reused for every message) or,
 * when that is not possible, by the public link. Written against a small set of dependencies so it can be tested.
 */
export type HeaderFile = { bytes: Uint8Array; mime: string; filename: string };

export type MediaIdDeps = {
  /** A stored ID that is still safe to use, or null. */
  lookup(sourceUrl: string, phoneNumberId: string): Promise<string | null>;
  save(sourceUrl: string, phoneNumberId: string, mediaId: string): Promise<void>;
  forget(sourceUrl: string, phoneNumberId: string): Promise<void>;
  /** Reads the file back from our own storage; null when the link is not one of ours. */
  fetchFile(sourceUrl: string): Promise<HeaderFile | null>;
  upload(phoneNumberId: string, file: HeaderFile): Promise<string>;
};

export type ResolvedMedia = { id: string; fresh: boolean };

export function createHeaderMediaResolver(deps: MediaIdDeps) {
  const running = new Map<string, Promise<ResolvedMedia | null>>();
  let disabled = false;

  async function load(url: string, phoneNumberId: string): Promise<ResolvedMedia | null> {
    try {
      const stored = await deps.lookup(url, phoneNumberId);
      if (stored) return { id: stored, fresh: false };
      const file = await deps.fetchFile(url);
      if (!file) return null;
      const id = await deps.upload(phoneNumberId, file);
      try { await deps.save(url, phoneNumberId, id); } catch { /* the ID still works for this run */ }
      return { id, fresh: true };
    } catch {
      return null; // the caller falls back to the public link
    }
  }

  return {
    /** A media ID for this file, or null to send the public link instead. Never throws. */
    resolve(url: string, phoneNumberId: string): Promise<ResolvedMedia | null> {
      if (disabled) return Promise.resolve(null);
      const key = `${phoneNumberId}|${url}`;
      const existing = running.get(key);
      if (existing) return existing;
      const task = load(url, phoneNumberId).finally(() => running.delete(key));
      running.set(key, task);
      return task;
    },
    /**
     * WhatsApp refused the ID. An old stored ID is simply dropped so the next send uploads again; an ID that was
     * uploaded a moment ago and still refused means IDs do not work here, so this process sends links.
     */
    async rejected(url: string, phoneNumberId: string, media: ResolvedMedia): Promise<void> {
      if (media.fresh) disabled = true;
      try { await deps.forget(url, phoneNumberId); } catch { /* best effort */ }
    },
  };
}

/** Meta error codes that can mean "this media reference was not accepted". */
export const MEDIA_REFERENCE_ERROR_CODES: ReadonlySet<number> = new Set([100, 131009, 131052, 131053, 132012]);

/** WhatsApp keeps uploaded media for 30 days; stop using an ID after 25. */
export const MEDIA_ID_TTL_MS = 25 * 24 * 60 * 60 * 1000;
