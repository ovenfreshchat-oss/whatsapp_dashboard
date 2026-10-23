"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { sendMetaTestMessage, type TestSendState } from "./actions";
import styles from "./meta.module.css";

export type TestTemplateOption = {
  key: string;
  label: string;
  body: string;
  parameterKeys: string[];
  headerFormat?: "IMAGE" | "TEXT" | null;
};

const initialState: TestSendState = { error: "", success: "", messageId: "" };

function SubmitButton() {
  const { pending } = useFormStatus();
  return <button className={styles.primaryButton} type="submit" disabled={pending}>{pending ? "Sending test…" : "Send one test message"}</button>;
}

export function TestSendForm({ recipient, options }: { recipient: string; options: TestTemplateOption[] }) {
  const [state, action] = useActionState(sendMetaTestMessage, initialState);
  const [selected, setSelected] = useState(options[0]?.key ?? "");
  const template = options.find((item) => item.key === selected);

  return (
    <form action={action} className={styles.testForm}>
      <label className={styles.field}>
        <span>Approved marketing template</span>
        <select name="templateKey" required value={selected} onChange={(event) => setSelected(event.target.value)}>
          {options.map((item) => <option value={item.key} key={item.key}>{item.label}</option>)}
        </select>
      </label>

      {template && template.headerFormat === "IMAGE" && (
        <label className={styles.field} key={`${selected}-header`}>
          <span>Header image URL (HTTPS)</span>
          <input
            name="headerMediaUrl"
            type="url"
            pattern="https://.*"
            placeholder="https://example.com/banner.jpg"
            required
          />
          <small>Meta requires a publicly accessible HTTPS URL for image headers.</small>
        </label>
      )}

      {template && (
        <div className={styles.templatePreview}>
          <span>TEMPLATE BODY</span>
          <p>{template.body}</p>
        </div>
      )}

      {template && template.parameterKeys.length > 0 && (
        <label className={styles.field}>
          <span>Body values ({template.parameterKeys.length}, one per line)</span>
          <textarea
            name="bodyParameters"
            rows={Math.min(6, template.parameterKeys.length + 1)}
            placeholder={template.parameterKeys.map((key) => `Value for {{${key}}}`).join("\n")}
            required
          />
        </label>
      )}
      {(!template || template.parameterKeys.length === 0) && <input type="hidden" name="bodyParameters" value="" />}

      <label className={styles.field}>
        <span>Configured test recipient</span>
        <input type="tel" name="recipientE164" value={recipient} readOnly />
      </label>

      <label className={styles.consentLabel}>
        <input type="checkbox" name="testConsent" value="yes" required />
        <span>I control this test number or have its owner&apos;s explicit permission to receive this WhatsApp template.</span>
      </label>

      <p className={styles.helper}>This action sends exactly one message. Meta acceptance is not delivery; check webhook status before repeating a test.</p>
      <SubmitButton />
      {(state.error || state.success) && (
        <p className={state.error ? styles.formError : styles.formSuccess} role="status">
          {state.error || state.success}
          {state.messageId && <small>Message ID: {state.messageId}</small>}
        </p>
      )}
    </form>
  );
}
