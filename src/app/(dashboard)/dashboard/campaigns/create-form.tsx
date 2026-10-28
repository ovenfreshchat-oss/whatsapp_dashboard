"use client";

import { useActionState, useEffect, useRef, useState, type FormEvent } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { Spinner } from "@/components/ui/spinner";
import { useFeedback } from "@/components/ui/feedback";
import { createCampaignDraftAction, type CampaignActionState } from "./actions";
import type { CampaignImportBatchOption } from "@/server/campaigns/admin";
import styles from "./campaigns.module.css";

export type CampaignTemplateOption = {
  key: string;
  label: string;
  body: string;
  parameterKeys: string[];
  headerFormat?: "IMAGE" | "TEXT" | null;
};

const initialState: CampaignActionState = { error: "", success: "" };
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function CreateButton() {
  const { pending } = useFormStatus();
  return <button type="submit" className={styles.primaryButton} disabled={pending} aria-busy={pending || undefined}>
    {pending ? <><Spinner /> Creating draft…</> : "Continue → choose when to send"}
  </button>;
}

/** "text" -> "Text", "order_date" -> "Order date"; numbered placeholders become "Value 1". */
function valueLabel(key: string): string {
  if (/^\d+$/.test(key)) return `Value ${key}`;
  const words = key.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

type Errors = { name?: string; template?: string; audience?: string; image?: string; values?: Record<number, string> };

/** One text box per blank in the message. They are sent to the server as one value per line. */
function BodyValues({ keys, errors, onEdit }: { keys: string[]; errors: Record<number, string>; onEdit: (index: number) => void }) {
  const [values, setValues] = useState<string[]>(() => keys.map(() => ""));
  return <div className={styles.valueFields}>
    {keys.map((key, index) => <label className={styles.field} key={key}>
      <span>{valueLabel(key)}</span>
      <input type="text" value={values[index]} maxLength={1000} data-value-index={index}
        aria-invalid={errors[index] ? true : undefined}
        placeholder={`Enter ${valueLabel(key).toLowerCase()}`}
        onChange={(event) => {
          onEdit(index);
          setValues((old) => old.map((value, at) => (at === index ? event.target.value.replace(/[\r\n]+/g, " ") : value)));
        }} />
      {errors[index] ? <span className="fieldError" style={{ color: "var(--danger-700)", fontSize: 12, fontWeight: 600 }} role="alert">{errors[index]}</span> : <small>Fills {`{{${key}}}`} in the message</small>}
    </label>)}
    <input type="hidden" name="bodyParameters" value={values.map((value) => value.trim()).join("\n")} />
  </div>;
}

function FieldError({ children }: { children?: string }) {
  return children ? <span style={{ color: "var(--danger-700)", fontSize: 12, fontWeight: 600 }} role="alert">{children}</span> : null;
}

export function CreateCampaignForm({ options, batches }: {
  options: CampaignTemplateOption[];
  batches: CampaignImportBatchOption[];
}) {
  const [state, action] = useActionState(createCampaignDraftAction, initialState);
  const { toast } = useFeedback();
  const [selected, setSelected] = useState(options[0]?.key ?? "");
  const [selectedAudience, setSelectedAudience] = useState(batches[0] ? `batch:${batches[0].id}` : "");
  const [preview, setPreview] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const handled = useRef(state);
  const template = options.find((item) => item.key === selected);

  // A server-side failure (for example Meta rejecting the image) is shown as a message and kept inline.
  useEffect(() => {
    if (state === handled.current) return;
    handled.current = state;
    if (state.error) toast({ tone: "error", title: "Draft not created", message: state.error });
  }, [state, toast]);

  function validate(event: FormEvent<HTMLFormElement>) {
    const form = event.currentTarget;
    const data = new FormData(form);
    const next: Errors = {};
    const name = String(data.get("name") ?? "").trim();
    if (!name) next.name = "Give the campaign a name.";
    if (!selected) next.template = "Choose an approved template.";
    if (!selectedAudience) next.audience = "Choose who should receive it.";
    if (template?.headerFormat === "IMAGE") {
      const image = data.get("headerImage");
      if (!(image instanceof File) || image.size === 0) next.image = "This template needs a header image (JPG or PNG).";
      else if (!/^image\/(jpeg|png)$/.test(image.type)) next.image = "Use a JPG or PNG image.";
      else if (image.size > MAX_IMAGE_BYTES) next.image = "The image is larger than 4 MB. Choose a smaller one.";
    }
    if (template?.parameterKeys.length) {
      const values = String(data.get("bodyParameters") ?? "").split("\n");
      const missing: Record<number, string> = {};
      template.parameterKeys.forEach((key, index) => {
        if (!(values[index] ?? "").trim()) missing[index] = `Enter ${valueLabel(key).toLowerCase()}.`;
      });
      if (Object.keys(missing).length) next.values = missing;
    }
    setErrors(next);
    if (Object.keys(next).length) {
      event.preventDefault();
      toast({ tone: "error", title: "Check the highlighted fields", message: "Some required details are missing." });
      requestAnimationFrame(() => form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
    }
  }

  return <form action={action} className={`${styles.form} ${styles.createGrid}`} noValidate
    onSubmit={(event) => { if (!event.defaultPrevented) validate(event); }}>
    <div className={styles.formCol}>
    <label className={styles.field}>
      <span>Campaign name</span>
      <input name="name" type="text" maxLength={120} placeholder="October weekend offer"
        aria-invalid={errors.name ? true : undefined} onChange={() => errors.name && setErrors({ ...errors, name: undefined })} />
      <FieldError>{errors.name}</FieldError>
    </label>
    <label className={styles.field}>
      <span>Approved marketing template</span>
      <select name="templateKey" value={selected} onChange={(event) => setSelected(event.target.value)} aria-invalid={errors.template ? true : undefined}>
        {options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
      </select>
      <FieldError>{errors.template}</FieldError>
    </label>
    <label className={styles.field}>
      <span>Choose contact list</span>
      <select name="audienceSource" value={selectedAudience} aria-invalid={errors.audience ? true : undefined}
        onChange={(event) => setSelectedAudience(event.target.value)}>
        {!batches.length && <option value="">Select a contact list</option>}
        {batches.map((batch) => <option key={batch.id} value={`batch:${batch.id}`}>
          {batch.fileName} · uploaded {batch.createdAt.slice(0, 10)} · {batch.acceptedRows} imported rows
        </option>)}
        <option value="all">All eligible contacts across imports</option>
      </select>
      <FieldError>{errors.audience}</FieldError>
      {!batches.length && <small>No uploads yet. <Link href="/dashboard/contacts">Upload contacts</Link> first, or pick all eligible contacts.</small>}
    </label>
    </div>
    <div className={styles.formCol}>
    {template && template.headerFormat === "IMAGE" && <label className={styles.field} key={`${selected}-header`}>
      <span>Header image (JPG or PNG, up to 4 MB)</span>
      <input
        name="headerImage"
        type="file"
        accept="image/jpeg,image/png"
        aria-invalid={errors.image ? true : undefined}
        onChange={(event) => {
          const file = event.target.files?.[0];
          setErrors((old) => ({ ...old, image: undefined }));
          setPreview((old) => { if (old) URL.revokeObjectURL(old); return file ? URL.createObjectURL(file) : ""; });
        }}
      />
      <FieldError>{errors.image}</FieldError>
      {preview && /* eslint-disable-next-line @next/next/no-img-element */
        <img src={preview} alt="Selected header preview" className={styles.headerImagePreview} />}
    </label>}
    {template && <div className={styles.templatePreview}>
      <span>Template body</span>
      <p>{template.body}</p>
    </div>}
    {template && template.parameterKeys.length > 0
      ? <BodyValues key={selected} keys={template.parameterKeys} errors={errors.values ?? {}}
          onEdit={(index) => errors.values?.[index] && setErrors((old) => ({ ...old, values: { ...old.values, [index]: "" } }))} />
      : <input name="bodyParameters" type="hidden" value="" />}
    </div>
    <div className={styles.formFooter}>
      <Link href="/dashboard/campaigns" className={styles.refreshLink}>Cancel</Link>
      <CreateButton />
    </div>
    {state.error && <p className={styles.formError} role="alert">{state.error}</p>}
  </form>;
}
