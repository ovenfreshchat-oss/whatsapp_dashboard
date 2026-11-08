"use client";

import { useActionState, useEffect, useRef, useState, type FormEvent } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { Spinner } from "@/components/ui/spinner";
import { WhatsAppPreview, type PreviewButton } from "@/components/ui/whatsapp-preview";
import { useFeedback } from "@/components/ui/feedback";
import { createCampaignDraftAction, type CampaignActionState } from "./actions";
import { previewFailedContactsAction } from "./[campaignId]/failed-actions";
import { SELECTION_KEY } from "./[campaignId]/failed-controls";
import { checkHeaderVideo, prepareHeaderVideo, uploadHeaderVideo } from "@/lib/header-video-upload";
import { compressHeaderImage } from "@/lib/media-compress";
import { describeExclusion } from "@/server/campaigns/retry-explain";
import type { FailedContactPreview } from "@/server/campaigns/retries";
import type { CampaignImportBatchOption } from "@/server/campaigns/admin";
import styles from "./campaigns.module.css";

export type CampaignTemplateOption = {
  key: string;
  label: string;
  body: string;
  parameterKeys: string[];
  headerFormat?: "IMAGE" | "VIDEO" | "TEXT" | null;
  footer?: string | null;
  buttons?: PreviewButton[];
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

type Errors = { name?: string; template?: string; audience?: string; image?: string; video?: string; values?: Record<number, string> };

/** One text box per blank in the message. They are sent to the server as one value per line. */
function BodyValues({ keys, errors, onEdit, onValues }: { keys: string[]; errors: Record<number, string>; onEdit: (index: number) => void; onValues: (values: string[]) => void }) {
  const [values, setValues] = useState<string[]>(() => keys.map(() => ""));
  useEffect(() => { onValues(values); }, [values, onValues]);
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

/** Recipients picked in a campaign's Failed Messages tab. Shows who can and cannot be messaged before anything is created. */
function FailedSelection({ campaignId, campaignName }: { campaignId: string; campaignName: string }) {
  const [ids, setIds] = useState<string[] | null | undefined>(undefined);
  const [preview, setPreview] = useState<FailedContactPreview | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    let picked: { campaignId?: string; ids?: string[] | null } | null = null;
    try {
      const raw = sessionStorage.getItem(SELECTION_KEY);
      picked = raw ? JSON.parse(raw) : null;
    } catch { picked = null; }
    if (!picked || picked.campaignId !== campaignId || picked.ids === undefined) {
      setError("No contacts are selected. Go back to the campaign's Failed Messages tab and select contacts.");
      return;
    }
    setIds(picked.ids);
    previewFailedContactsAction(campaignId, picked.ids).then((result) => {
      if (cancelled) return;
      if (result.error) setError(result.error); else setPreview(result.preview);
    }).catch(() => { if (!cancelled) setError("The selection could not be checked. Try again."); });
    return () => { cancelled = true; };
  }, [campaignId]);
  return <div className={styles.field}>
    <span>Recipients: failed contacts from {campaignName}</span>
    <input type="hidden" name="sourceCampaignId" value={campaignId} />
    <input type="hidden" name="failureIds" value={ids === undefined ? "" : ids === null ? "all" : JSON.stringify(ids)} />
    {error ? <FieldError>{error}</FieldError> : !preview ? <small>Checking who can be messaged…</small> : <>
      <strong>{preview.eligible} will be included · {preview.excluded} excluded</strong>
      {Object.entries(preview.reasons).map(([reason, count]) => <small key={reason}>{count} excluded: {describeExclusion(reason)}</small>)}
      <small>Contacts on a waiting time, Do Not Send hold, suppression or Global Opt Out are never included. Failure counts are not reset.</small>
    </>}
  </div>;
}

/** The template body with the typed values filled in. Blanks stay as {{name}} until a value is typed. */
function fillValues(body: string, keys: string[], values: string[]): string {
  const byKey = new Map(keys.map((key, index) => [key, values[index]?.trim() ?? ""]));
  return body.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (match, key: string) => byKey.get(key) || match);
}

function FieldError({ children }: { children?: string }) {
  return children ? <span style={{ color: "var(--danger-700)", fontSize: 12, fontWeight: 600 }} role="alert">{children}</span> : null;
}

export function CreateCampaignForm({ options, batches, source }: {
  options: CampaignTemplateOption[];
  batches: CampaignImportBatchOption[];
  source?: { campaignId: string; campaignName: string };
}) {
  const [state, action] = useActionState(createCampaignDraftAction, initialState);
  const { toast } = useFeedback();
  const [selected, setSelected] = useState(options[0]?.key ?? "");
  const [selectedAudience, setSelectedAudience] = useState(batches[0] ? `batch:${batches[0].id}` : "");
  const [preview, setPreview] = useState("");
  const [liveValues, setLiveValues] = useState<string[]>([]);
  const [videoUrl, setVideoUrl] = useState("");
  const [videoPreview, setVideoPreview] = useState("");
  const [videoBusy, setVideoBusy] = useState(false);
  const [videoNote, setVideoNote] = useState("");
  const [imageBusy, setImageBusy] = useState(false);
  const [imageNote, setImageNote] = useState("");
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
    if (!source && !selectedAudience) next.audience = "Choose who should receive it.";
    if (template?.headerFormat === "IMAGE") {
      const image = data.get("headerImage");
      if (imageBusy) next.image = "The image is still being optimised. Wait a moment.";
      else if (!(image instanceof File) || image.size === 0) next.image = "This template needs a header image (JPG or PNG).";
      else if (!/^image\/(jpeg|png)$/.test(image.type)) next.image = "Use a JPG or PNG image.";
      else if (image.size > MAX_IMAGE_BYTES) next.image = "The image is larger than 4 MB. Choose a smaller one.";
    }
    if (template?.headerFormat === "VIDEO") {
      if (videoBusy) next.video = "The video is still uploading. Wait a moment.";
      else if (!videoUrl) next.video = "This template needs a header video (MP4, up to 16 MB).";
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
    {source ? <FailedSelection campaignId={source.campaignId} campaignName={source.campaignName} /> : <label className={styles.field}>
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
    </label>}
    </div>
    <div className={styles.formCol}>
    {template && template.headerFormat === "IMAGE" && <label className={styles.field} key={`${selected}-header`}>
      <span>Header image (JPG or PNG, large images are optimised automatically)</span>
      <input
        name="headerImage"
        type="file"
        accept="image/jpeg,image/png"
        aria-invalid={errors.image ? true : undefined}
        onChange={async (event) => {
          const input = event.currentTarget;
          const file = input.files?.[0];
          setErrors((old) => ({ ...old, image: undefined }));
          setImageNote("");
          setPreview((old) => { if (old) URL.revokeObjectURL(old); return ""; });
          if (!file) return;
          setImageBusy(true);
          const result = await compressHeaderImage(file);
          if (result.file !== file) {
            try { const transfer = new DataTransfer(); transfer.items.add(result.file); input.files = transfer.files; } catch { /* keep the original */ }
          }
          setImageNote(input.files?.[0] === result.file ? result.message : "");
          setPreview(URL.createObjectURL(input.files?.[0] ?? file));
          setImageBusy(false);
        }}
      />
      {imageBusy && <small>Optimising the image…</small>}
      {imageNote && !imageBusy && <small>{imageNote}</small>}
      <FieldError>{errors.image}</FieldError>
      {preview && /* eslint-disable-next-line @next/next/no-img-element */
        <img src={preview} alt="Selected header preview" className={styles.headerImagePreview} />}
    </label>}
    {template && template.headerFormat === "VIDEO" && <label className={styles.field} key={`${selected}-video`}>
      <span>Header video (MP4, large videos are optimised automatically)</span>
      <input type="file" accept="video/mp4" disabled={videoBusy} aria-invalid={errors.video ? true : undefined}
        onChange={async (event) => {
          const file = event.target.files?.[0];
          setErrors((old) => ({ ...old, video: undefined }));
          setVideoUrl("");
          setVideoPreview((old) => { if (old) URL.revokeObjectURL(old); return ""; });
          if (!file) return;
          const invalid = checkHeaderVideo(file);
          if (invalid) { setErrors((old) => ({ ...old, video: invalid })); event.target.value = ""; return; }
          setVideoBusy(true);
          setVideoNote("Optimising the video… 0%");
          try {
            const prepared = await prepareHeaderVideo(file, (fraction) => setVideoNote(`Optimising the video… ${Math.round(fraction * 100)}%`));
            setVideoPreview(URL.createObjectURL(prepared.file));
            setVideoNote("Uploading the video…");
            setVideoUrl(await uploadHeaderVideo(prepared.file));
            setVideoNote(prepared.message);
          } catch (error) {
            setErrors((old) => ({ ...old, video: error instanceof Error ? error.message : "The video could not be uploaded." }));
            setVideoPreview((old) => { if (old) URL.revokeObjectURL(old); return ""; });
            setVideoNote("");
            event.target.value = "";
          } finally { setVideoBusy(false); }
        }} />
      <input type="hidden" name="headerVideoUrl" value={videoUrl} />
      {videoBusy && <small>{videoNote}</small>}
      {videoUrl && !videoBusy && <small>Video uploaded. {videoNote}</small>}
      <FieldError>{errors.video}</FieldError>
    </label>}
    {template && <WhatsAppPreview
      headerVideoUrl={template.headerFormat === "VIDEO" ? videoPreview || null : null}
      headerVideoMissing={template.headerFormat === "VIDEO" && !videoPreview}
      headerImageUrl={template.headerFormat === "IMAGE" ? preview || null : null}
      headerImageMissing={template.headerFormat === "IMAGE" && !preview}
      body={fillValues(template.body, template.parameterKeys, liveValues)}
      footer={template.footer}
      buttons={template.buttons} />}
    {template && template.parameterKeys.length > 0
      ? <BodyValues key={selected} keys={template.parameterKeys} errors={errors.values ?? {}}
          onValues={setLiveValues}
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
