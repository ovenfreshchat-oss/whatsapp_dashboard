"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import styles from "../campaigns/campaigns.module.css";

export type TemplateFormInitial = {
  format: "positional" | "named";
  id: string;
  name: string;
  language: string;
  category: string;
  body: string;
  footer: string;
  hasImageHeader: boolean;
};

const LANGUAGES: [string, string][] = [
  ["en_US", "English (US)"], ["en_GB", "English (UK)"], ["en", "English"],
  ["ml", "Malayalam"], ["hi", "Hindi"], ["ta", "Tamil"], ["ar", "Arabic"],
];

function variableKeys(body: string, named: boolean): string[] {
  const found = [...body.matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/g)].map((m) => m[1]);
  const unique = [...new Set(found)];
  return named ? unique : unique.sort((a, b) => Number(a) - Number(b));
}

export function TemplateForm({ initial }: { initial?: TemplateFormInitial }) {
  const router = useRouter();
  const editing = Boolean(initial);
  const [name, setName] = useState(initial?.name ?? "");
  const [language, setLanguage] = useState(initial?.language ?? "en_US");
  const [category, setCategory] = useState(initial?.category === "UTILITY" ? "UTILITY" : "MARKETING");
  const [body, setBody] = useState(initial?.body ?? "");
  const [footer, setFooter] = useState(initial?.footer ?? "");
  const [examples, setExamples] = useState<string[]>([]);
  const [image, setImage] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const named = initial?.format === "named";
  const keys = useMemo(() => variableKeys(body, named), [body, named]);
  const count = keys.length;
  const nextKey = named ? (count === 0 ? "customer_name" : `variable_${["one","two","three","four","five","six","seven","eight","nine"][count] ?? "more"}`) : String(count + 1);
  const preview = useMemo(() => image ? URL.createObjectURL(image) : "", [image]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setDone("");
    try {
      const form = new FormData();
      if (initial) form.set("templateId", initial.id);
      form.set("name", name);
      form.set("language", language);
      form.set("category", category);
      form.set("format", named ? "named" : "positional");
      form.set("body", body);
      form.set("footer", footer);
      form.set("examples", JSON.stringify(Array.from({ length: count }, (_, i) => examples[i] ?? "")));
      if (image) form.set("image", image);
      const response = await fetch("/api/templates/save", { method: "POST", body: form });
      const value = await response.json().catch(() => ({})) as { error?: string; status?: string | null };
      if (!response.ok) throw new Error(value.error ?? "Could not save the template.");
      setDone(`Sent to WhatsApp for review${value.status ? ` (${value.status.toLowerCase()})` : ""}. It can be used in campaigns once it is approved, usually within minutes.`);
      router.refresh();
      if (!editing) { setName(""); setBody(""); setFooter(""); setExamples([]); setImage(null); }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the template.");
    } finally {
      setBusy(false);
    }
  }

  return <form className={styles.form} onSubmit={submit}>
    {!editing && <label className={styles.field}>Name
      <input value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))} placeholder="october_offer" maxLength={100} required />
      <small>Lowercase letters, numbers and underscores. It cannot be changed later.</small>
    </label>}
    {!editing && <label className={styles.field}>Language
      <select value={language} onChange={(e) => setLanguage(e.target.value)}>{LANGUAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
    </label>}
    {!editing && <label className={styles.field}>Type
      <select value={category} onChange={(e) => setCategory(e.target.value)}>
        <option value="MARKETING">Marketing (offers, promotions)</option>
        <option value="UTILITY">Utility (order or account updates)</option>
      </select>
    </label>}
    <label className={styles.field}>Image at the top (optional)
      <input type="file" accept="image/jpeg,image/png" onChange={(e) => setImage(e.target.files?.[0] ?? null)} />
      <small>{initial?.hasImageHeader ? "This template has an image. WhatsApp needs it again when you edit: choose it again." : "JPG or PNG, under 5 MB."}</small>
      {preview && /* eslint-disable-next-line @next/next/no-img-element */ <img className={styles.headerImagePreview} src={preview} alt="Header preview" />}
    </label>
    <label className={styles.field}>Message
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} maxLength={1024} required placeholder={"Hi {{1}}, our October offer is live! Get 20% off until Sunday."} />
      <small>
        {body.length}/1024 · <button type="button" onClick={() => setBody((b) => `${b}{{${nextKey}}}`)}>+ Add variable</button> adds {`{{${nextKey}}}`} (for a name or code). Variables cannot be the first or last thing in the message.
      </small>
    </label>
    {Array.from({ length: count }, (_, i) => (
      <label className={styles.field} key={i}>Sample for {`{{${keys[i]}}}`}
        <input value={examples[i] ?? ""} onChange={(e) => setExamples((all) => { const next = [...all]; next[i] = e.target.value; return next; })} placeholder={i === 0 ? "Rahul" : "Sample value"} required />
        <small>WhatsApp asks for an example so it can review the message.</small>
      </label>
    ))}
    <label className={styles.field}>Footer (optional)
      <input value={footer} onChange={(e) => setFooter(e.target.value)} maxLength={60} placeholder="Reply STOP to opt out" />
    </label>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {done && <p className={styles.helper} role="status">{done}</p>}
    <button type="submit" className={styles.primaryButton} disabled={busy}>{busy ? "Sending…" : editing ? "Save changes" : "Create template"}</button>
  </form>;
}
