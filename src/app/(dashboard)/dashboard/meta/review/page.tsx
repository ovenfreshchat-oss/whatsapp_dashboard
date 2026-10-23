import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { createStaffAdminClient, getStaffAdminAccess } from "@/server/auth/staff-users/admin";
import { getConfiguredMetaIdentifiers, getMetaConfigurationStatus } from "@/server/meta/client";
import { ReconcileConfirmedHoldForm, ReleaseHoldForm } from "./release-form";
import styles from "./review.module.css";

export const metadata: Metadata = {
  title: "Inbound WhatsApp review | The Oven Fresh",
  description: "Review inbound WhatsApp opt-outs before releasing sender holds.",
};

type HoldRow = {
  waba_id: string;
  phone_number_id: string;
  reason: string;
  source_item_key: string;
  created_at: string;
};
type AmbiguousEventRow = {
  source_item_key: string;
  waba_id: string;
  phone_number_id: string;
  received_at: string;
};
type ConfirmedEventRow = AmbiguousEventRow & { identity_value: string | null };
type ReviewEvent = AmbiguousEventRow & {
  review_kind: "ambiguous_opt_out" | "unreconciled_opt_out";
  identity_value: string | null;
};
type InboxRow = {
  dedupe_key: string;
  kind: string;
  waba_id: string;
  phone_number_id: string | null;
  provider_message_id: string | null;
  event_timestamp: string | null;
  needs_review: boolean;
  payload: unknown;
  received_at: string;
};
type ReviewRow = {
  id: string;
  waba_id: string;
  phone_number_id: string;
  review_kind: string;
  recipient_e164: string | null;
  review_reason: string;
  reviewed_at: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function value(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function evidence(payload: unknown): Array<{ label: string; text: string }> {
  const message = record(payload);
  const button = record(message?.button);
  const interactive = record(message?.interactive);
  const reply = record(interactive?.button_reply) ?? record(interactive?.list_reply);
  const fields = [
    { label: "Text", text: value(record(message?.text)?.body) },
    { label: "Button text", text: value(button?.text) },
    { label: "Button payload", text: value(button?.payload) },
    { label: "Reply title", text: value(reply?.title) },
    { label: "Reply ID", text: value(reply?.id) },
  ];
  return fields.filter((field): field is { label: string; text: string } => field.text !== null);
}

function dateLabel(input: string | null): string {
  if (!input) return "—";
  const date = new Date(input);
  return Number.isNaN(date.valueOf()) ? "—" : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function canonicalRecipient(identity: string | null): string | null {
  return identity && /^\+?[1-9][0-9]{7,14}$/.test(identity)
    ? `+${identity.replace(/^\+/, "")}` : null;
}

export default async function MetaInboundReviewPage() {
  const access = await getStaffAdminAccess();
  if (access === "signed-out") redirect("/sign-in");
  if (access !== "allowed") redirect("/access-denied");

  const sender = getMetaConfigurationStatus().configured ? getConfiguredMetaIdentifiers() : null;
  const admin = createStaffAdminClient();
  const [holdsResult, reviewsResult] = admin && sender ? await Promise.all([
    admin.from("meta_sender_holds")
      .select("waba_id,phone_number_id,reason,source_item_key,created_at", { count: "exact" })
      .eq("waba_id", sender.wabaId).eq("phone_number_id", sender.phoneNumberId)
      .is("released_at", null)
      .order("created_at", { ascending: false }).limit(50),
    admin.from("meta_sender_hold_reviews")
      .select("id,waba_id,phone_number_id,review_kind,recipient_e164,review_reason,reviewed_at")
      .eq("waba_id", sender.wabaId).eq("phone_number_id", sender.phoneNumberId)
      .order("reviewed_at", { ascending: false }).limit(10),
  ]) : [null, null];
  const storageReady = Boolean(holdsResult && !holdsResult.error && reviewsResult && !reviewsResult.error);
  const holds = (storageReady ? holdsResult?.data ?? [] : []) as HoldRow[];
  const reviews = (storageReady ? reviewsResult?.data ?? [] : []) as ReviewRow[];
  const [ambiguousResult, confirmedResult] = admin && sender && holds.length ? await Promise.all([
    admin.from("meta_ambiguous_opt_out_events")
      .select("source_item_key,waba_id,phone_number_id,received_at", { count: "exact" })
      .eq("waba_id", sender.wabaId).eq("phone_number_id", sender.phoneNumberId)
      .is("reviewed_at", null).order("received_at", { ascending: true }).limit(50),
    admin.from("meta_confirmed_opt_out_events")
      .select("source_item_key,waba_id,phone_number_id,identity_value,received_at", { count: "exact" })
      .eq("waba_id", sender.wabaId).eq("phone_number_id", sender.phoneNumberId)
      .is("reviewed_at", null).order("received_at", { ascending: true }).limit(50),
  ]) : [null, null];
  const eventsReady = !holds.length || Boolean(ambiguousResult && !ambiguousResult.error &&
    confirmedResult && !confirmedResult.error);
  const events: ReviewEvent[] = eventsReady ? [
    ...((ambiguousResult?.data ?? []) as AmbiguousEventRow[]).map((event) =>
      ({ ...event, review_kind: "ambiguous_opt_out" as const, identity_value: null })),
    ...((confirmedResult?.data ?? []) as ConfirmedEventRow[]).map((event) =>
      ({ ...event, review_kind: "unreconciled_opt_out" as const })),
  ].sort((left, right) => left.received_at.localeCompare(right.received_at)) : [];
  const identities = [...new Set(events.map((event) => event.identity_value).filter(
    (identity): identity is string => identity !== null,
  ))];
  const itemResult = admin && events.length ? await admin.from("meta_webhook_items")
    .select("dedupe_key,kind,waba_id,phone_number_id,provider_message_id,event_timestamp,needs_review,payload,received_at")
    .in("dedupe_key", events.map((event) => event.source_item_key)) : null;
  const optOutResult = admin && sender && identities.length ? await admin.from("meta_opt_outs")
    .select("identity_value")
    .eq("waba_id", sender.wabaId).eq("phone_number_id", sender.phoneNumberId)
    .in("identity_value", identities) : null;
  const evidenceReady = eventsReady && (!events.length || Boolean(itemResult && !itemResult.error)) &&
    (!identities.length || Boolean(optOutResult && !optOutResult.error));
  const suppressedIdentities = new Set<string>((optOutResult?.data ?? [])
    .map((row) => row.identity_value).filter((identity): identity is string => typeof identity === "string"));
  const items = new Map<string, InboxRow>(
    ((evidenceReady ? itemResult?.data ?? [] : []) as InboxRow[])
      .map((item) => [item.dedupe_key, item]),
  );

  return <DashboardShell label="WhatsApp integration" showMetaSetup>
    <div className={styles.content}>
      <Link href="/dashboard/meta" className={styles.backLink}>← WhatsApp setup</Link>
      <div className={styles.intro}>
        <div><span className={styles.eyebrow}>INTEGRATIONS / INBOUND REVIEW</span>
          <h1>Sender holds<span>.</span></h1>
          <p>Review inbound STOP requests and ambiguous messages before clearing a sender-wide pause.</p>
        </div>
        <Link href="/dashboard/meta/review" className={styles.refreshLink}>Refresh evidence ↻</Link>
      </div>

      <section className={styles.notice}>
        <strong>Release only after checking the original message.</strong>
        <p>A sender hold pauses all campaigns on this WhatsApp sender. Review every inbound opt-out event with a written reason. A clear STOP can be reconciled only after its recipient-specific opt-out is stored. The sender hold releases after the last pending event is reviewed; the recipient opt-out remains active. Missing or non-phone WhatsApp identities remain held until an external verified mapping or support process resolves them.</p>
      </section>

      {!sender && <section className={styles.notice}>
        <strong>Meta sender configuration is incomplete.</strong>
        <p>Configure the WhatsApp sender before reviewing its inbound holds.</p>
      </section>}
      {sender && !storageReady && <section className={styles.notice}>
        <strong>Review storage is unavailable.</strong>
        <p>Apply the current <code>drizzle/0001_meta_webhook_inbox.sql</code> migration to the configured Supabase database.</p>
      </section>}
      {storageReady && !evidenceReady && <section className={styles.notice}>
        <strong>Inbox evidence could not be loaded.</strong>
        <p>Refresh before reviewing any message.</p>
      </section>}

      <section className={styles.panel} aria-labelledby="pending-heading">
        <div className={styles.panelHeading}><div><span className={styles.eyebrow}>PENDING REVIEW</span>
          <h2 id="pending-heading">Inbound opt-out holds</h2></div>
          <span>{storageReady ? `${holdsResult?.count ?? holds.length} active` : "Unavailable"}</span>
        </div>
        {holds.length ? <div className={styles.holdList}>{holds.map((hold) => {
          const pending = events.filter((event) => event.waba_id === hold.waba_id &&
            event.phone_number_id === hold.phone_number_id);
          return <article className={styles.holdCard} key={`${hold.waba_id}:${hold.phone_number_id}`}>
            <div className={styles.holdHeading}><strong>Sender {hold.phone_number_id}</strong>
              <span>Held {dateLabel(hold.created_at)}</span></div>
            <p className={styles.more}>{(ambiguousResult?.count ?? 0) + (confirmedResult?.count ?? 0)} inbound events remain for this sender. Each needs its own review.</p>
            {pending.length ? <div className={styles.eventList}>{pending.map((event) => {
              const item = items.get(event.source_item_key);
              const matching = item?.kind === "message" && item.needs_review &&
                item.waba_id === hold.waba_id && item.phone_number_id === hold.phone_number_id;
              const details = matching ? evidence(item.payload) : [];
              const customer = matching ? value(record(item.payload)?.from) : null;
              const canReview = evidenceReady && matching && details.length > 0;
              return <section className={styles.eventCard} key={event.source_item_key}>
                <div className={styles.holdHeading}><strong>{event.review_kind === "unreconciled_opt_out" ? "Confirmed STOP" : "Ambiguous inbound message"}</strong>
                  <span>Received {dateLabel(event.received_at)}</span></div>
                <dl className={styles.facts}>
                  <div><dt>WABA</dt><dd>{hold.waba_id}</dd></div>
                  <div><dt>Customer WhatsApp ID</dt><dd>{customer ?? "Unavailable"}</dd></div>
                  {event.review_kind === "unreconciled_opt_out" &&
                    <div><dt>Recipient-specific opt-out</dt><dd>{event.identity_value && suppressedIdentities.has(event.identity_value) ? "Stored" : "Unavailable"}</dd></div>}
                  <div><dt>Message ID</dt><dd>{matching ? item.provider_message_id ?? "Unavailable" : "Unavailable"}</dd></div>
                  <div><dt>Event time</dt><dd>{dateLabel(matching ? item.event_timestamp : null)}</dd></div>
                </dl>
                {details.length ? <div className={styles.evidence}>
                  <strong>Inbound evidence</strong>
                  {details.map((detail) => <div key={detail.label}><span>{detail.label}</span><p>{detail.text}</p></div>)}
                </div> : <p className={styles.unavailable}>The inbox message is missing or has no readable opt-out evidence. This message cannot be cleared here.</p>}
                {event.review_kind === "ambiguous_opt_out" && canReview && hold.reason === "ambiguous_opt_out" &&
                  <ReleaseHoldForm wabaId={hold.waba_id}
                    phoneNumberId={hold.phone_number_id} sourceItemKey={event.source_item_key} />}
                {event.review_kind === "ambiguous_opt_out" && hold.reason === "unreconciled_opt_out" &&
                  <p className={styles.more}>Reconcile the confirmed STOP events first. This message can then be reviewed.</p>}
                {event.review_kind === "unreconciled_opt_out" && canReview &&
                  hold.reason === "unreconciled_opt_out" && event.identity_value &&
                  customer === event.identity_value && canonicalRecipient(event.identity_value) &&
                  suppressedIdentities.has(event.identity_value) &&
                  <ReconcileConfirmedHoldForm wabaId={hold.waba_id}
                    phoneNumberId={hold.phone_number_id} sourceItemKey={event.source_item_key}
                    providerIdentity={event.identity_value} />}
                {event.review_kind === "unreconciled_opt_out" &&
                  (!event.identity_value || !canonicalRecipient(event.identity_value) ||
                    !suppressedIdentities.has(event.identity_value) || customer !== event.identity_value) &&
                  <p className={styles.unavailable}>This STOP remains held. Its WhatsApp identity needs an externally verified phone mapping or support resolution and a stored recipient-specific opt-out.</p>}
              </section>;
            })}</div> : <p className={styles.unavailable}>No pending source events were found for this active hold. It cannot be released here.</p>}
            {(ambiguousResult?.count ?? 0) + (confirmedResult?.count ?? 0) > pending.length &&
              <p className={styles.more}>Showing the oldest 50 events of each type. Review these to see the remaining events.</p>}
          </article>;
        })}</div> : <p className={styles.empty}>{storageReady ? "No inbound sender holds need review." : sender ? "Apply the migration to view pending holds." : "Configure the sender to view pending holds."}</p>}
      </section>

      <section className={styles.panel} aria-labelledby="history-heading">
        <div className={styles.panelHeading}><div><span className={styles.eyebrow}>AUDIT</span>
          <h2 id="history-heading">Recent message reviews</h2></div><span>Latest 10</span></div>
        {reviews.length ? <ol className={styles.history}>{reviews.map((review) =>
          <li key={review.id}><strong>Sender {review.phone_number_id}</strong>
            <span>{dateLabel(review.reviewed_at)}</span>
            <p>{review.review_kind === "unreconciled_opt_out" ? `STOP for ${review.recipient_e164 ?? "unknown recipient"}. ` : "Ambiguous message. "}{review.review_reason}</p></li>)}</ol>
          : <p className={styles.empty}>{storageReady ? "No inbound messages have been reviewed." : "Review history will appear after setup."}</p>}
      </section>
    </div>
  </DashboardShell>;
}
