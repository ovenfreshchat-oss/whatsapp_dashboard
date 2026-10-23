"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
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
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const form = new FormData();
      form.set("conversationId", conversationId);
      form.set("clientToken", token);
      form.set("body", body);
      if (file) form.set("file", file);
      const response = await fetch("/api/inbox/send", { method: "POST", body: form });
      const value = await response.json().catch(() => null) as { error?: string; success?: string; nextToken?: string } | null;
      if (!value) throw new Error("The server did not answer. Check the thread before resending.");
      if (value.nextToken) setToken(value.nextToken);
      if (value.success) {
        setBody("");
        setFile(null);
        if (fileRef.current) fileRef.current.value = "";
        setSuccess(value.success);
      }
      if (value.error) setError(value.error);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The message could not be sent.");
    } finally {
      setBusy(false);
    }
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
      <label className={styles.composerField}>
        <span className={styles.srOnly}>Reply</span>
        <textarea
          ref={textRef}
          rows={3}
          maxLength={limit}
          disabled={locked}
          value={body}
          placeholder={locked ? "Replies are unavailable." : file ? "Add a caption (optional)" : "Write a reply (Ctrl+Enter to send)"}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send(); }
          }}
        />
      </label>
      {pickerOpen && !locked && (
        <div className={styles.emojiPicker} role="listbox" aria-label="Emoji">
          {EMOJIS.map((emoji) => <button type="button" key={emoji} onClick={() => insertEmoji(emoji)}>{emoji}</button>)}
        </div>
      )}
      <div className={styles.composerFooter}>
        <span className={styles.tools}>
          <button type="button" className={styles.toolButton} disabled={locked} onClick={() => setPickerOpen((open) => !open)} aria-label="Add emoji">😊</button>
          <button type="button" className={styles.toolButton} disabled={locked} onClick={() => fileRef.current?.click()} aria-label="Attach photo or video">📎</button>
          <input ref={fileRef} type="file" hidden accept="image/jpeg,image/png,video/mp4,video/3gpp" onChange={(event) => choose(event.target.files?.[0] ?? null)} />
          <span className={styles.counter}>{body.length}/{limit}</span>
        </span>
        <button className={styles.sendButton} type="submit" disabled={!canSend}>{busy ? (file ? "Uploading…" : "Sending…") : "Send"}</button>
      </div>
      {(error || success) && <p className={error ? styles.formError : styles.formSuccess} role="status">{error || success}</p>}
    </form>
  );
}
