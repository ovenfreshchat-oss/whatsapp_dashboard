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
    {pending ? "Creating draft…" : "Create draft"}
  </button>;
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
  const template = options.find((item) => item.key === selected);
  const selectedBatch = batches.find((item) => selectedAudience === `batch:${item.id}`);

  return <form action={action} className={styles.form}>
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
      <span>Audience source</span>
      <select name="audienceSource" value={selectedAudience} onChange={(event) =>
        setSelectedAudience(event.target.value)} required>
      {!batches.length && <option value="">Select an audience source</option>}
        {batches.map((batch) => <option key={batch.id} value={`batch:${batch.id}`}>
          {batch.fileName} · uploaded {batch.createdAt.slice(0, 10)} · {batch.acceptedRows} imported rows
        </option>)}
        <option value="all">All eligible contacts across imports</option>
      </select>
    </label>
    {template && template.headerFormat === "IMAGE" && <label className={styles.field} key={`${selected}-header`}>
      <span>Header image URL (HTTPS)</span>
      <input
        name="headerMediaUrl"
        type="url"
        pattern="https://.*"
        placeholder="https://example.com/banner.jpg"
        required
      />
      <small>Meta requires a publicly accessible HTTPS URL for image headers.</small>
    </label>}
    {template && <div className={styles.templatePreview}>
      <span>TEMPLATE BODY</span>
      <p>{template.body}</p>
    </div>}
    {template && template.parameterKeys.length > 0 ? <label className={styles.field} key={selected}>
      <span>Body values ({template.parameterKeys.length}, one per line)</span>
      <textarea
        name="bodyParameters"
        rows={Math.min(7, template.parameterKeys.length + 1)}
        placeholder={template.parameterKeys.map((key) => `Value for {{${key}}}`).join("\n")}
        required
      />
    </label> : <input name="bodyParameters" type="hidden" value="" />}
    <div className={styles.formNote}>
      <strong>Audience snapshot</strong>
      <p>{selectedBatch
        ? `Only contacts with a verified Yes claim from “${selectedBatch.fileName}” and current marketing eligibility enter this draft. ${selectedBatch.pendingClaims} Yes claims were imported; any unreviewed claims stay out.`
        : "The all-eligible option deliberately includes eligible contacts across imports."} The selected audience is frozen now. Review the resulting count before scheduling.</p>
    </div>
    <CreateButton />
    {state.error && <p className={styles.formError} role="alert">{state.error}</p>}
  </form>;
}
