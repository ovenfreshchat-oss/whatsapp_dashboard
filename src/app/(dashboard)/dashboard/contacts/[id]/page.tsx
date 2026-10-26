import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BackLink } from "@/components/ui/back-link";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { createStaffAdminClient } from "@/server/auth/staff-users/admin";
import { getConfiguredMetaIdentifiers, getMetaConfigurationStatus } from "@/server/meta/client";
import { ConsentRecordForm } from "../record-form";
import styles from "../contacts.module.css";

export const metadata: Metadata = { title: "Contact consent | The Oven Fresh" };

type Contact = { id: string; phone_e164: string; display_name: string | null; created_at: string };
type Event = {
  id: string; decision: string; verification_status: string; source: string | null;
  notice_text: string | null; evidence_reference: string | null;
  occurred_at: string | null; recorded_at: string; import_batch_id: string | null;
};

function dateLabel(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export default async function ContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();
  const admin = createStaffAdminClient();
  if (!admin) throw new Error("The contact database is unavailable.");
  const { data: contactData, error: contactError } = await admin.from("contacts")
    .select("id,phone_e164,display_name,created_at").eq("id", id).single();
  if (contactError || !contactData) notFound();
  const contact = contactData as Contact;
  const [eventsResult, suppressionResult] = await Promise.all([
    admin.from("contact_consent_events")
      .select("id,decision,verification_status,source,notice_text,evidence_reference,occurred_at,recorded_at,import_batch_id")
      .eq("contact_id", id).order("recorded_at", { ascending: false }).limit(30),
    admin.from("contact_marketing_suppressions")
      .select("id,reason,source,created_at").eq("phone_e164", contact.phone_e164)
      .is("released_at", null).limit(1),
  ]);
  const events = (eventsResult.data ?? []) as Event[];
  let eligible: boolean | null = null;
  if (getMetaConfigurationStatus().configured) {
    const { wabaId, phoneNumberId } = getConfiguredMetaIdentifiers();
    const { data, error } = await admin.rpc("can_send_whatsapp_marketing", {
      p_contact_id: id, p_waba_id: wabaId, p_phone_number_id: phoneNumberId,
    });
    if (!error) eligible = data === true;
  }
  const suppressed = Boolean(suppressionResult.data?.length);

  return <DashboardShell label="Contacts · consent" showMetaSetup><div className={styles.content}>
    <BackLink href="/dashboard/contacts">Back to contacts</BackLink>
    <div className={styles.intro}><div><span className={styles.eyebrow}>CONTACT / CONSENT</span><h1>{contact.display_name || "Contact"}<span>.</span></h1><p>{contact.phone_e164} · Added {dateLabel(contact.created_at)}</p></div><span className={styles.countPill}>{suppressed ? "Suppressed" : eligible === true ? "Eligible for marketing" : eligible === false ? "Not eligible" : "Eligibility unavailable"}</span></div>
    <section className={styles.panel}><div className={styles.panelHeading}><div><span className={styles.eyebrow}>EVIDENCE</span><h2>Record consent or an opt-out</h2></div></div><ConsentRecordForm contactId={id} idempotencyKey={randomUUID()} /></section>
    <section className={styles.panel}><div className={styles.panelHeading}><div><span className={styles.eyebrow}>AUDIT TRAIL</span><h2>Consent history</h2></div></div>
      {eventsResult.error ? <p className={styles.empty}>Consent history is unavailable.</p> : events.length ? <div className={styles.eventList}>{events.map((event) => <article className={styles.eventRow} key={event.id}><div><strong>{event.decision === "grant" ? "Opt-in" : "Opt-out"} · {event.verification_status}</strong><small>{dateLabel(event.occurred_at)} · Recorded {dateLabel(event.recorded_at)}</small></div><p>Source: {event.source ?? "Imported claim"}<br />Evidence: {event.evidence_reference ?? "—"}<br />Notice: {event.notice_text ?? "—"}</p></article>)}</div> : <p className={styles.empty}>No consent records yet. This contact cannot enter a campaign.</p>}
    </section>
  </div></DashboardShell>;
}
