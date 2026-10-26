"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { emitOptimistic } from "./live";
import styles from "./inbox.module.css";

const EMOJIS = [
  "😀", "😁", "😂", "🤣", "😊", "😍", "😘", "😎", "🤩", "🥰", "😇", "🙂",
  "😉", "🤗", "🤔", "😅", "😢", "😭", "😡", "🙏", "👍", "👎", "👏", "🙌",
  "👌", "✌️", "💪", "🤝", "❤️", "💙", "💚", "🔥", "⭐", "✨", "🎉", "🎁",
  "🍕", "🍔", "🍰", "☕", "🍪", "🥐", "🎂", "🍫", "✅", "❌", "📍", "📞",
];

const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_VIDEO = 16 * 1024 * 1024;

function fileProblem(file: File): string {
  if (["image/jpeg", "image/png"].includes(file.type)) return file.size > MAX_IMAGE ? "A photo must be under 5 MB." : "";
  if (["video/mp4", "video/3gpp"].includes(file.type)) return file.size > MAX_VIDEO ? "A video must be under 16 MB." : "";
  return "Choose a JPG or PNG photo, or an MP4 video.";
}

export function ReplyForm({
  conversationId,
  initialToken,
  disabledReason,
}: {
  conversationId: string;
  initialToken: string;
  /** When set, the composer is locked and this explains why. */
  disabledReason: string | null;
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [token, setToken] = useState(initialToken);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : ""), [file]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  // Switching conversations starts a fresh draft.
  useEffect(() => { setBody(""); setFile(null); setError(""); setSuccess(""); setPickerOpen(false); }, [conversationId]);

  const locked = disabledReason !== null;
  const limit = file ? 1024 : 4096;
  const canSend = !locked && !busy && (file !== null || body.trim().length > 0);

  function insertEmoji(emoji: string) {
    const el = textRef.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    const next = body.slice(0, start) + emoji + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(start + emoji.length, start + emoji.length); });
  }

  function choose(selected: File | null) {
    if (!selected) return;
    const problem = fileProblem(selected);
    if (problem) { setError(problem); return; }
    setError("");
    setFile(selected);
  }

  async function send() {
    if (!canSend) return;
    const draftText = body;
    const draftFile = file;
    const bubbleId = crypto.randomUUID();
    emitOptimistic({ type: "add", id: bubbleId, conversationId, text: draftText.trim(), media: Boolean(draftFile) });
    setBody("");
    if (textRef.current) textRef.current.style.height = "auto";
    setFile(null);
    if (fileRef.current) fileRef.current.value = "";
    let delivered = false;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const form = new FormData();
      form.set("conversationId", conversationId);
      form.set("clientToken", token);
      form.set("body", draftText);
      if (draftFile) form.set("file", draftFile);
      const response = await fetch("/api/inbox/send", { method: "POST", body: form });
      const value = await response.json().catch(() => null) as { error?: string; success?: string; nextToken?: string } | null;
      if (!value) throw new Error("The server did not answer. Check the thread before resending.");
      if (value.nextToken) setToken(value.nextToken);
      if (value.success && !value.error) {
        delivered = true;
        emitOptimistic({ type: "sent", id: bubbleId });
        setSuccess(value.success);
      }
      if (value.error) setError(value.error);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The message could not be sent.");
    } finally {
      if (!delivered) {
        // Not sent: drop the temporary bubble and give the draft back so nothing is lost.
        emitOptimistic({ type: "remove", id: bubbleId });
        setBody((current) => current || draftText);
        setFile((current) => current ?? draftFile);
      }
      setBusy(false);
    }
  }

  function autosize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }

  return (
    <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); void send(); }}>
      {locked && <p className={styles.lockNotice} role="status">{disabledReason}</p>}
      {file && (
        <div className={styles.attachment}>
          {file.type.startsWith("video/")
            ? <video src={preview} className={styles.attachmentThumb} muted />
            // eslint-disable-next-line @next/next/no-img-element
            : <img src={preview} alt="" className={styles.attachmentThumb} />}
          <span>{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</span>
          <button type="button" onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ""; }}>Remove</button>
        </div>
      )}
      {pickerOpen && !locked && (
        <div className={styles.emojiPicker} role="listbox" aria-label="Emoji">
          {EMOJIS.map((emoji) => <button type="button" key={emoji} onClick={() => insertEmoji(emoji)}>{emoji}</button>)}
        </div>
      )}
      <div className={styles.composerRow}>
        <div className={styles.inputPill}>
          <button type="button" className={styles.iconButton} disabled={locked} onClick={() => setPickerOpen((open) => !open)} aria-label="Add emoji">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M8.5 14.2c.8 1.2 2 1.8 3.5 1.8s2.7-.6 3.5-1.8" /><circle cx="9" cy="9.6" r=".6" fill="currentColor" /><circle cx="15" cy="9.6" r=".6" fill="currentColor" /></svg>
          </button>
          <label className={styles.composerField}>
            <span className={styles.srOnly}>Reply</span>
            <textarea
              ref={textRef}
              rows={1}
              maxLength={limit}
              disabled={locked}
              value={body}
              placeholder={locked ? "Replies are unavailable." : file ? "Add a caption" : "Type a message"}
              onChange={(event) => { setBody(event.target.value); autosize(event.target); }}
              onKeyDown={(event) => {
                // Enter sends and Shift+Enter adds a line, as in WhatsApp Web (phones keep Enter as a new line).
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && window.matchMedia("(pointer: fine)").matches) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
          </label>
          <button type="button" className={styles.iconButton} disabled={locked} onClick={() => fileRef.current?.click()} aria-label="Attach photo or video">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m20.5 11.5-8.2 8.2a5 5 0 0 1-7-7l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.8 1.8 0 0 1-2.5-2.5l7.9-7.9" /></svg>
          </button>
          <input ref={fileRef} type="file" hidden accept="image/jpeg,image/png,video/mp4,video/3gpp" onChange={(event) => choose(event.target.files?.[0] ?? null)} />
        </div>
        <button className={styles.sendButton} type="submit" disabled={!canSend} aria-label={busy ? "Sending" : "Send"}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M3.4 20.4 21 12 3.4 3.6l.01 6.5L15 12 3.41 13.9z" /></svg>
        </button>
      </div>
      {body.length > limit - 200 && <span className={styles.counter}>{body.length}/{limit}</span>}
      {(error || success) && <p className={error ? styles.formError : styles.formSuccess} role="status">{error || success}</p>}
    </form>
  );
}
