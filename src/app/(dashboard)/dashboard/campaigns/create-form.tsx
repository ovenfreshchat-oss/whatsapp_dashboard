"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
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

function CreateButton() {
  const { pending } = useFormStatus();
  return <button type="submit" className={styles.primaryButton} disabled={pending}>
    {pending ? "Preparing…" : "Continue → choose when to send"}
  </button>;
}

/** "text" -> "Text", "order_date" -> "Order date"; numbered placeholders become "Value 1". */
function valueLabel(key: string): string {
  if (/^\d+$/.test(key)) return `Value ${key}`;
  const words = key.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** One text box per blank in the message. They are sent to the server as one value per line. */
function BodyValues({ keys }: { keys: string[] }) {
  const [values, setValues] = useState<string[]>(() => keys.map(() => ""));
  return <div className={styles.valueFields}>
    {keys.map((key, index) => <label className={styles.field} key={key}>
      <span>{valueLabel(key)}</span>
      <input type="text" value={values[index]} maxLength={1000} required
        placeholder={`Enter ${valueLabel(key).toLowerCase()}`}
        onChange={(event) => setValues((old) => old.map((value, at) => (at === index ? event.target.value.replace(/[\r\n]+/g, " ") : value)))} />
      <small>Fills {`{{${key}}}`} in the message</small>
    </label>)}
    <input type="hidden" name="bodyParameters" value={values.map((value) => value.trim()).join("\n")} />
  </div>;
}

export function CreateCampaignForm({ options, batches }: {
  options: CampaignTemplateOption[];
  batches: CampaignImportBatchOption[];
}) {
  const [state, action] = useActionState(createCampaignDraftAction, initialState);
  const [selected, setSelected] = useState(options[0]?.key ?? "");
  const [selectedAudience, setSelectedAudience] = useState(
    batches[0] ? `batch:${batches[0].id}` : "",
  );
  const [preview, setPreview] = useState("");
  const template = options.find((item) => item.key === selected);

  return <form action={action} className={`${styles.form} ${styles.createGrid}`}>
    <div className={styles.formCol}>
    <label className={styles.field}>
      <span>Campaign name</span>
      <input name="name" type="text" maxLength={120} placeholder="October weekend offer" required />
    </label>
    <label className={styles.field}>
      <span>Approved marketing template</span>
      <select name="templateKey" value={selected} onChange={(event) => setSelected(event.target.value)} required>
        {options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
      </select>
    </label>
    <label className={styles.field}>
      <span>Choose contact list</span>
      <select name="audienceSource" value={selectedAudience} onChange={(event) =>
        setSelectedAudience(event.target.value)} required>
      {!batches.length && <option value="">Select a contact list</option>}
        {batches.map((batch) => <option key={batch.id} value={`batch:${batch.id}`}>
          {batch.fileName} · uploaded {batch.createdAt.slice(0, 10)} · {batch.acceptedRows} imported rows
        </option>)}
        <option value="all">All eligible contacts across imports</option>
      </select>
    </label>
    </div>
    <div className={styles.formCol}>
    {template && template.headerFormat === "IMAGE" && <label className={styles.field} key={`${selected}-header`}>
      <span>Header image (JPG or PNG, up to 4 MB)</span>
      <input
        name="headerImage"
        type="file"
        accept="image/jpeg,image/png"
        required
        onChange={(event) => {
          const file = event.target.files?.[0];
          setPreview((old) => { if (old) URL.revokeObjectURL(old); return file ? URL.createObjectURL(file) : ""; });
        }}
      />
      {preview && /* eslint-disable-next-line @next/next/no-img-element */
        <img src={preview} alt="Selected header preview" className={styles.headerImagePreview} />}
    </label>}
    {template && <div className={styles.templatePreview}>
      <span>TEMPLATE BODY</span>
      <p>{template.body}</p>
    </div>}
    {template && template.parameterKeys.length > 0
      ? <BodyValues key={selected} keys={template.parameterKeys} />
      : <input name="bodyParameters" type="hidden" value="" />}
    </div>
    <div className={styles.formFooter}><CreateButton /></div>
    {state.error && <p className={styles.formError} role="alert">{state.error}</p>}
  </form>;
}
