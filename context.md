# The Oven Fresh — WhatsApp marketing dashboard architecture

**Status update (16 October 2026):** The repository now implements Meta account checks, signed webhooks, contact imports from CSV/XLSX/DOCX, consent review, campaign drafts, scheduling, and a gated worker. SQL migrations are in `drizzle/` but have not been applied to the configured Supabase project. Meta values and a public HTTPS callback are still needed for live verification. The sections below preserve the original 11 October architecture proposal and may describe work as planned; use the root README and migration README for current setup.

This document records the starting state, recommended design, operational safeguards, and decisions needed before business backend or infrastructure work. Supabase email/password sign-in uses the project URL and publishable key supplied in the local environment, and the dashboard verifies the current user and staff access server-side. Admin-only direct staff creation and a first-admin bootstrap command require a server-only Supabase secret key; the admin email allowlist is configured locally. Broader role policy remains pending. No Meta credentials, customer data, approvals, or existing integrations have been provided or verified.

## 1. Evidence and scope

The labels in this document have distinct meanings:

- **Verified repository fact:** Observed in the local project directory during this planning task.
- **Client-provided requirement:** Stated in the pasted project brief; not independently verified as an existing capability.
- **Verified public fact:** Supported by a linked public source, checked on the review date.
- **Proposed decision:** A design recommendation, subject to client approval and implementation validation.
- **Unknown:** Needs evidence or a client decision.

### Repository at the start of planning

| Item | Finding |
| --- | --- |
| Repository contents | **Verified repository fact:** The project root contained only `context.md`, initially a short instruction note. This document replaces that note. |
| Source and tooling | **Verified repository fact:** No application source, `package.json`, lockfile, `next.config.*`, TypeScript configuration, tests, README, environment template, or dependency manifest was present. No installed dependency can be established from this folder. |
| Version control | **Verified repository fact:** The folder is not a Git working tree; `git status` and `git rev-parse` report no repository. |
| Existing infrastructure | **Unknown:** No deployment, database, queue, Meta app, WABA, phone number ID, token, or webhook configuration is documented locally. |

The [public website](https://theovenfresh.ca/) describes The Oven Fresh as a South Asian take-out restaurant, with pickup, delivery, and catering and links for Scarborough and Oshawa. This is **verified public business context**, not evidence of a particular legal entity, customer database, WhatsApp eligibility, consent, or hosting arrangement. The brief supplies the requirement to keep using an existing WhatsApp Business App number through coexistence; its eligibility is **unknown**.

### Project objective and boundaries

**Client-provided requirement:** A professional, single-client dashboard for staff to manage opted-in contacts, select approved WhatsApp marketing templates, create and schedule campaigns, send through the **official Meta WhatsApp Cloud API**, and track message outcomes. The eventual scope includes CSV import, segments, template sync and preview, queue-based sending, webhooks, analytics, history, authentication and roles, consent, and opt-outs.

**Proposed decision:** Build one TypeScript Next.js App Router application plus one persistent Node.js worker from the same codebase. Begin as a single-business system. Do not add SaaS tenancy or microservices unless the client confirms a multi-client product. Do not send marketing from the browser or from long-running HTTP requests.

## 2. Requirements and product rules

1. Staff can add and search contacts, import CSVs with row-level validation, normalize phone numbers to E.164 where provided, and review duplicates and consent evidence before inclusion in campaigns. A contact may be stored as ineligible while evidence is being reviewed.
2. Segments are saved filter definitions. A campaign snapshots eligible recipients, template identity/version, language, variable mapping, audience counts, schedule, and sender so later contact edits cannot silently expand the audience.
3. Only a currently approved marketing template in the appropriate language may be selected for business-initiated promotional messages. Preview uses sample or masked data, never an actual send.
4. Campaigns require a review/launch step, can be scheduled, paused, resumed, or canceled, and show counts for eligible, suppressed, pending, accepted by Meta, sent, delivered, read, failed, and uncertain outcomes.
5. A fresh consent and suppression check occurs at **send time**, including after resume or retry. Imported phone numbers alone never authorize a send. Opt-outs block future marketing across every campaign.
6. All outbound sends and inbound Meta events have durable records. Duplicate queue delivery and webhook replay must not create duplicate business actions.
7. A successful Cloud API request means Meta accepted it for processing; only later webhooks establish sent, delivered, read, or failed status. Missing or delayed webhooks remain visibly unresolved.
8. Staff accounts are created directly by authorized admins, with roles, audit history, server-side authorization, and no Meta secret in client code.

For the first release, **proposed decision:** prohibit free-form outbound marketing and use approved templates only. A future customer-service reply feature would need separate rules for the 24-hour service window. Meta's [Business Messaging Policy](https://whatsappbusiness.com/policy/) requires appropriate opt-in, respect for opt-outs, and approved templates for business-initiated messages.

## 3. Recommended stack and architecture

| Concern | Proposed decision and reason | Trade-off / alternative |
| --- | --- | --- |
| Web application | **Next.js App Router + TypeScript, Node.js runtime.** Server Components for authenticated reads; Route Handlers or server actions for small mutations. | Matches the requested stack. Route Handlers are public endpoints and every mutation needs its own auth/authorization check. [Next.js guidance](https://nextjs.org/docs/app/guides/backend-for-frontend), [authorization guidance](https://nextjs.org/docs/app/guides/authentication). |
| UI and validation | Accessible component primitives, Tailwind CSS, Zod for input boundaries, streaming CSV parser. | Exact UI/parser packages can be pinned when implementation begins; avoid a large design system before workflows are proven. |
| Database | **Managed PostgreSQL** for transactional state, unique constraints, relational reports, and auditable history. | SQLite is simpler locally but less suitable for concurrent web and worker writes; MongoDB adds complexity to relational campaign/recipient data. |
| Database access | **Drizzle ORM + reviewed SQL migrations**; keep explicit indexes and transactions visible. | Prisma is a valid alternative with a more guided schema/client workflow; Drizzle offers direct SQL control for queue coordination and reporting. [Drizzle schema](https://orm.drizzle.team/docs/sql-schema-declaration), [migrations](https://orm.drizzle.team/docs/migrations). |
| Queue | **pg-boss** on the same PostgreSQL database, processed by a separate always-on Node worker. Enqueue in the business transaction where possible; use retries and dead-letter review. | Fewer services than BullMQ + Redis; PostgreSQL takes queue load and requires careful capacity monitoring. BullMQ/Redis is an option if throughput grows enough to justify another service. Neither queue makes a third-party API call exactly once. [pg-boss](https://github.com/timgit/pg-boss), [queue options](https://github.com/timgit/pg-boss/blob/master/docs/api/queues.md). |
| Staff authentication | **Implemented foundation:** Supabase Auth email/password with SSR cookies, server-side claim verification, and admin-only direct user creation. Application roles must still be checked in services. | Project URL and publishable key are configured locally. Direct creation requires a server-only secret key and admin email allowlist. Role schema, MFA policy, and the relationship to the proposed business database remain open. |
| Hosting target | **Proposed production target:** AWS Canada (Central) `ca-central-1`, with two ECS Fargate services (Next.js web/API and persistent worker), RDS PostgreSQL, Secrets Manager, and monitored logs. | Supports a Canadian hosting option and durable workers, but is more costly and operationally involved than a PaaS. Final host/region depends on budget, operations owner, and data-residency requirements. Hosting in Canada does not make Meta's processing or all vendors Canada-only. [AWS regions](https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html). |

Architecture at a glance:

```text
Staff browser -> Next.js dashboard/API -> PostgreSQL (business state + pg-boss jobs)
                                      -> Meta Graph API (template sync and sends)
Meta webhooks -> verified Next.js webhook -> PostgreSQL inbox -> worker -> status/consent updates
Persistent worker -> due-campaign dispatcher -> recipient jobs -> Cloud API
```

The web process handles short requests. The worker handles due schedules, CSV processing, webhook processing, recipient sends, retries, and aggregates. Both share typed database and domain services, but only server code can import Meta credentials. Next.js notes that long-running Route Handlers may be terminated by hosts, so a web request is not the bulk sender ([source](https://nextjs.org/docs/app/guides/backend-for-frontend)).

## 4. Proposed folder and file tree

**Directory scaffold created on 11 October 2026.** The source folders below exist with responsibility notes and empty-directory placeholders. The `package.json`, TypeScript configuration, root layout, Supabase `/sign-in`, authenticated `/dashboard` shell, admin-only `/dashboard/users/new`, and Auth proxy now exist. The other application files shown in the tree are future locations; no business backend or migration exists yet. Route handlers should stay thin; domain services own business rules; worker handlers call those same services.

```text
.
├── context.md                         # This architecture and decision record
├── package.json                       # Next.js scripts/dependencies
├── next.config.ts                     # Future Next.js configuration
├── tsconfig.json                       # Strict TypeScript configuration
├── drizzle.config.ts                   # Future reviewed migration configuration
├── drizzle/                            # Future versioned SQL migrations
├── src/
│   ├── proxy.ts                       # Supabase session refresh and route redirects
│   ├── app/
│   │   ├── layout.tsx                 # App Router root layout
│   │   ├── (auth)/sign-in/page.tsx     # Supabase staff sign-in
│   │   ├── (dashboard)/dashboard/page.tsx # Protected dashboard shell
│   │   ├── (dashboard)/dashboard/users/new/page.tsx # Admin-only direct staff creation
│   │   ├── (dashboard)/contacts/page.tsx
│   │   ├── (dashboard)/contacts/import/page.tsx
│   │   ├── (dashboard)/segments/page.tsx
│   │   ├── (dashboard)/templates/page.tsx
│   │   ├── (dashboard)/campaigns/page.tsx
│   │   ├── (dashboard)/campaigns/new/page.tsx
│   │   ├── (dashboard)/campaigns/[campaignId]/page.tsx
│   │   ├── (dashboard)/analytics/page.tsx
│   │   ├── (dashboard)/settings/team/page.tsx
│   │   ├── (dashboard)/settings/whatsapp/page.tsx
│   │   ├── (dashboard)/settings/compliance/page.tsx
│   │   └── api/
│   │       ├── contacts/route.ts
│   │       ├── contacts/[contactId]/route.ts
│   │       ├── contacts/[contactId]/consent/route.ts
│   │       ├── contacts/import/route.ts
│   │       ├── contacts/import/[batchId]/commit/route.ts
│   │       ├── segments/route.ts
│   │       ├── segments/[segmentId]/route.ts
│   │       ├── templates/route.ts
│   │       ├── templates/sync/route.ts
│   │       ├── campaigns/route.ts
│   │       ├── campaigns/[campaignId]/route.ts
│   │       ├── campaigns/[campaignId]/schedule/route.ts
│   │       ├── campaigns/[campaignId]/pause/route.ts
│   │       ├── campaigns/[campaignId]/resume/route.ts
│   │       ├── campaigns/[campaignId]/cancel/route.ts
│   │       └── webhooks/meta/whatsapp/route.ts
│   ├── components/
│   │   ├── ui/                     # Shared accessible controls
│   │   └── layout/                 # Navigation and page framing
│   ├── features/
│   │   ├── contacts/               # Contact views, forms, CSV mapping UI
│   │   ├── consent/                # Consent display and opt-out UI
│   │   ├── segments/               # Filter builder and saved segment UI
│   │   ├── templates/              # Template list and preview UI
│   │   ├── campaigns/              # Composer, review, controls, detail UI
│   │   └── analytics/              # Charts, filters, exports
│   ├── server/
│   │   ├── auth/                   # Supabase sign-in/out and admin-only staff creation
│   │   ├── db/                     # Drizzle client, schemas, repositories
│   │   ├── meta/                   # Graph API client, template mapper, webhook verifier
│   │   ├── services/               # Contact, consent, segment, campaign, analytics rules
│   │   ├── jobs/                   # Queue setup, scheduler, handlers, limiter
│   │   ├── security/               # Input limits, audit writer, secret access
│   │   └── observability/          # Structured logs, metrics, alerts
│   ├── worker/index.ts             # Persistent process using server/jobs
│   └── lib/                        # Shared utilities and server-only Supabase client
└── tests/
    ├── unit/                       # Pure rules and state transitions
    ├── integration/                # DB, queue, API, webhook, provider fixtures
    ├── e2e/                        # Staff workflows using synthetic contacts
    └── fixtures/                   # Sanitized Meta payloads and CSV samples
```

`src/app` is routing and request handling, not business logic. `features` contains page-specific UI. `server/services` is the single authority for eligibility, scheduling, and state transitions. `server/db` owns constraints and queries; `server/meta` owns protocol details; `server/jobs` coordinates durable work and never creates a second copy of business rules. `worker/index.ts` starts the persistent process. Server-only helpers under `lib` must not be imported by browser code. The tree is intentionally single-repository and single-business.

## 5. Data model and relationships

Application-generated IDs should be opaque UUIDs; external Meta identifiers remain provider strings. Store timestamps in UTC, normalize known phone numbers to E.164, and enforce foreign keys/indexes in PostgreSQL. The following is a logical model, **not an existing schema or migration**.

| Entity | Key fields and relationships | Purpose / constraints |
| --- | --- | --- |
| `staff_user`, auth `session`/`account` | Identity provider subject, staff role (`owner`, `manager`, `marketer`, `viewer`), active flag; auth library owns session tables. | Admin-created access; no public signup. Do not use an editable email string as the sole identity key. |
| `contact` | E.164 phone unique when present, name, locale, optional attributes, import source, timestamps. | One canonical customer record per known phone; changes audited. A phone edit invalidates pending campaign eligibility until the destination and its consent are re-reviewed. |
| `contact_identity` | Contact (optional), sender/WABA scope, identity type (`phone` or Meta business-scoped user ID), normalized value, unique `(scope, type, value)`. | Maps inbound WhatsApp identities when Meta does not supply a phone number; do not presume every inbound opt-out can be resolved to an E.164 number. |
| `consent_event` | Contact/phone, purpose, source, timestamp, notice text/version, proof reference, actor, grant/revoke event. | Append-only evidence; imported consent needs verifiable provenance, not a checked CSV column alone. |
| `suppression` | Unique `(scope, identity type, normalized value)` for phone or provider-scoped ID, reason, source, effective time, limited audit reference. | Persistent send-time block across campaigns and re-imports; unresolved provider-ID opt-outs need reconciliation and a sender-level safety hold where matching is uncertain. |
| `import_batch` / `import_row_error` | File metadata, actor, counts, row number/error. | Trace imports, rejects, and duplicate handling; expire raw CSV after reviewed retention period. |
| `segment` | Name, validated filter JSON, owner, version. | Saved definition; resolve and snapshot at campaign review/launch. |
| `whatsapp_sender` | WABA ID, phone number ID, display number/metadata, capability/health flags. | IDs/configuration only; access tokens and app secret reside in secret storage. |
| `template` | WABA template ID/name, language, category, approval status, components/variable schema, last sync, content hash/version. | Cache Meta's current state; sending rechecks approved status and exact language. |
| `campaign` | Creator, sender, template snapshot/hash, segment snapshot, schedule UTC and IANA zone, approval/review fields, state. | Campaign definition and durable schedule; explicit review before launch. |
| `campaign_recipient` | Unique `(campaign_id, contact_id)`, exact destination phone/template-variable snapshot, current state, consent grant/evidence reference, claimed/last-attempt times, Meta `wamid` when known. | Frozen audience and authoritative per-person send state. Number changes invalidate pending recipients; counts derive from these rows. |
| `send_attempt` | Recipient, attempt number unique per recipient, prepared/in-flight/accepted/definite-failure/uncertain state, start/end, HTTP/Meta error code, request correlation, `wamid` if returned. | Operational history; a timeout or worker crash after the call may have begun is uncertain and cannot be blindly retried. |
| `webhook_inbox` / `webhook_item` | Envelope payload hash/receipt and child event dedupe key, sender/WABA, event type, processing state, sanitized payload/reference. | Verified, durable receipt for the whole POST; dedupe and process every nested message/status independently. Keep raw personal data briefly. |
| `message_event` | Recipient/`wamid`, event status, Meta event timestamp, receipt time, normalized error, dedupe key. | Append-only sent/delivered/read/failed timeline, tolerant of replay and out-of-order arrival. |
| `audit_log` | Actor, action, target, timestamp, safe details. | Roles, imports, consent edits, campaign launch/pause/cancel, and configuration changes. |

Relationships: contact 1-to-many consent events/identities and campaign recipients; segment 1-to-many campaigns by captured filter/version; sender 1-to-many templates and campaigns; campaign 1-to-many recipients; recipient 1-to-many attempts and message events; webhook inbox 1-to-many nested items. `wamid` maps a Meta accepted send to its recipient. Keep provider event history distinct from the recipient's current status projection. Aggregate campaign analytics from recipient rows/events first; introduce materialized counters only after actual performance demands it.

Indexes/constraints to plan: unique known contact phone; unique scoped provider identity and suppression keys; unique `(campaign, contact)` recipient; unique `(recipient, attempt_number)`; unique non-null `wamid` where appropriate; unique webhook envelope hash and item dedupe key; indexes for due campaigns, pending recipients, event lookup by `wamid`, and audit time. Store imported files only temporarily in restricted object storage or a bounded staging area, never in public assets.

## 6. API and server responsibilities

All staff routes require a current session, role check, input validation, pagination/size limits, and audit records for mutations. Role checks live in services and route handlers, not only in menus or layouts. Never trust client-submitted audience counts or eligibility flags.

| Route (proposed) | Responsibility |
| --- | --- |
| `GET/POST /api/contacts`, `GET/PATCH /api/contacts/:id` | Search/create/update contacts with normalization, dedupe, permission checks. |
| `POST /api/contacts/:id/consent` | Record reviewed consent evidence or immediate revocation/suppression; audit actor and source. |
| `POST /api/contacts/import`, `POST /api/contacts/import/:batchId/commit` | Stage a bounded CSV, enqueue parsing/validation, present row errors, then commit reviewed valid contacts with explicit eligible/ineligible consent state. Only eligible contacts can enter campaigns. |
| `GET/POST /api/segments`, `GET/PATCH /api/segments/:id` | Validate saved filter rules and estimate audience without sending. |
| `GET /api/templates`, `POST /api/templates/sync` | Read cached templates; authorized sync fetches Meta state and records changes. |
| `GET/POST /api/campaigns`, `GET/PATCH /api/campaigns/:id` | Draft, review, list, and inspect campaigns; edits stop after launch except allowed controls. |
| `POST /api/campaigns/:id/schedule` | Transactionally validate template, consent evidence, sender readiness, budget/limits, and freeze recipient snapshot; require launch role and idempotency key. |
| `POST /api/campaigns/:id/pause`, `/resume`, `/cancel` | Atomically change state with version/role checks and audit. Already accepted Meta sends cannot be recalled. |
| `GET/POST /api/webhooks/meta/whatsapp` | Public only for Meta verification/events: verify challenge or HMAC, bound request size, persist event, acknowledge quickly. No staff session on this endpoint. |
| Auth provider route | Library-owned login/session callbacks with explicit admin-managed account creation. |

Server modules: `contacts` validates/imports/dedupes; `consent` computes eligibility and suppression; `segments` evaluates filters; `campaigns` freezes audiences and controls state; `meta` encapsulates Graph version, API calls, template mapping and webhook protocol; `jobs` dispatches work and rate limits; `analytics` derives counts; `observability` records safe metrics/errors. No public job-processing endpoint is needed.

## 7. Official Meta WhatsApp Cloud API integration

**Proposed decision:** Integrate directly with Meta's Cloud API; no browser automation, unofficial gateway, or provider-specific sending API. Use a pinned, currently supported Graph API version selected during implementation, keep it in one `server/meta` client, and test upgrades against staging before changing it. Meta-owned [Cloud API examples](https://www.postman.com/meta/whatsapp-business-platform/collection/wlk6lh4/whatsapp-cloud-api) describe WABA/phone IDs, relevant permissions, and production system-user tokens. This document does not contain or presume any real IDs or tokens.

### Account readiness gate

Before coding a live send path, the client and authorized Meta administrator must establish the actual business portfolio/WABA, app ownership, phone number ID, display name/registration state, `whatsapp_business_messaging` and `whatsapp_business_management` permissions, production system-user token, template access, webhook subscription, quality/throughput/messaging allowances, and billing. **None is verified in this repository.** Business verification alone does not establish approval of the number, templates, permissions, or allowance.

**Client-provided coexistence requirement:** Keep using the existing WhatsApp Business App number. The [official coexistence onboarding documentation](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users) must be checked against this exact number, region, account, current app version, and available onboarding route. Do not unregister or migrate the number to test a theory. Get a written, account-specific go/no-go from the authorized Meta setup path before planning a cutover. A fallback that uses a different number would require the client's separate approval. Document any coexistence-specific webhook or throughput behavior found during that verification. The Meta developer page could not be fully retrieved during this review, so no eligibility claim is made here.

If coexistence is approved, validate and handle its account-state synchronization, history, and Business App message-echo events during staging. Record app-originated echoes for timeline/reconciliation without treating them as new campaign jobs or resending them. Confirm exact fields and throughput from the live Meta onboarding guide and actual account before setting limits.

### Templates and outbound requests

- Sync template name/ID, language, category, approval status, components, placeholders, and last-seen state from the WABA. Treat local cache as a preview; require a fresh status/category/language check before launch and before each bounded send batch. Pause when the cache is stale or Meta pauses/reclassifies a template; refresh on rejection.
- Permit marketing sends only through approved marketing templates and reviewed variable mappings. Escape/validate variable values, enforce length limits, and show a rendered preview with masked example data.
- Send server-side to `POST /{PHONE_NUMBER_ID}/messages` with `type=template`, name/language/components; store the returned `wamid` against the recipient/attempt. [Meta template-send example](https://www.postman.com/meta/whatsapp-business-platform/request/lwtlz1k/send-message-template-interactive).
- Do not infer that Meta acceptance equals delivery. Template rejection/pausing, quality controls, account limits, user blocks, and per-user marketing controls can prevent later delivery; surface these as operational outcomes. [Meta marketing guidance](https://whatsappbusiness.com/wp-content/uploads/2026/04/Best-Practices-for-Marketing-Messages-on-WhatsApp-.pdf).
- Read the account's current allowances and error responses; do not encode a guessed marketing tier or flat messages-per-second quota. The applicable limits depend on the actual account and number. [Meta messaging-limits documentation](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits).

## 8. Webhooks, message status, and inbound opt-outs

**Meta subscription:** Subscribe the app to the correct WABA and fields with an authorized system-user token; one WABA subscription covers its phone numbers according to [Meta's subscription examples](https://www.postman.com/meta/whatsapp-business-platform/folder/ozgs3jn/webhook-subscriptions). Route events by WABA/phone ID and reject unexpected senders.

1. **GET verification:** Compare `hub.verify_token` against a secret using constant-time comparison and return `hub.challenge` only for a valid subscription challenge.
2. **POST authenticity:** Verify `X-Hub-Signature-256` as HMAC-SHA256 over the exact raw request bytes using the Meta app secret before parsing JSON. Apply payload-size limits and reject invalid signatures. Confirm current field/signature requirements against [Meta's live webhook overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview) during setup; the [Meta-hosted SDK example](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/) illustrates the mechanism but is archived.
3. **Durable receipt and urgent opt-outs:** Parse every `entry[]`/`changes[]`/nested message and status in the signed, bounded payload. Persist a webhook envelope and event-level inbox items in PostgreSQL. For a recognized text or configured quick-reply opt-out, write the suppression/consent revocation in the same receipt transaction **before** returning HTTP 200; if that write fails, return non-2xx and raise an alert. The remaining status work can be asynchronous. This closes the avoidable window caused by a backlogged status worker, though a send already in flight cannot be recalled.
4. **Event dedupe and async processing:** Deduplicate the envelope by a stable digest and each nested item separately: provider message ID for inbound messages, or a canonical tuple/fingerprint including `wamid`, status, recipient, and event timestamp for status events. Verify the exact payload shape during implementation. A duplicate valid delivery returns success without repeating effects. Worker stores append-only `message_event`, maps `statuses[].id` (`wamid`) to a send attempt, and applies an idempotent status projection. Known statuses include `sent`, `delivered`, `read`, and `failed` with errors on failures ([Meta status payload reference](https://www.postman.com/meta/whatsapp-business-platform/folder/fuaee8l/statuses-object)). Retry correlation when a status arrives before the API response is stored; retain still-unmatched events for investigation.
5. **Ordering:** Use Meta event timestamp plus receipt timestamp, preserve the raw event sequence, and prevent an older `sent` event from downgrading `read`. Handle contradictory statuses as a visible exception; do not fabricate a clean success. A recipient can remain `accepted` or `unknown` when no later event arrives.
6. **Inbound opt-out:** Detect keywords such as STOP and reasonable variants plus configured quick-reply button payloads ([Meta inbound message types](https://www.postman.com/meta/whatsapp-business-platform/folder/1dtuocp/messages-object)). Suppress by known phone or Meta business-scoped user ID and block every future matching marketing send. A provider ID without a reliable phone mapping must still be suppressed and flagged for urgent reconciliation; apply a conservative sender-level hold if outbound phone campaigns cannot be safely matched. Provide staff-entered and external opt-out paths too; Meta policy requires honoring requests received on or off WhatsApp. Ambiguous messages need manual review. Minimize retention of inbound content. [Meta business-scoped ID reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids) requires live verification because the page was unavailable during this review.

Meta webhook signature validation authenticates the sender of the HTTP request; it does not establish that every event maps to a campaign. Record unmatched IDs and alert when matching or processing fails. Alert on webhook silence, repeated signature failures, queue backlog, and a rise in failed or unacknowledged sends.

## 9. Scheduling, queue processing, retries, and rate control

**Scheduling:** Store `scheduled_at_utc`, the intended IANA time zone (likely `America/Toronto` for the business unless the client chooses otherwise), and the displayed local time. Validate daylight-saving transitions. A persistent scheduler claims due campaigns with row locking/optimistic versions and queues bounded batches. Keep long-term schedules in the campaign table rather than relying on queue retention defaults. If the scheduler is down, due campaigns remain discoverable and resume safely.

**Launch transaction:** Revalidate campaign ownership/role, approved template, consent policy, sender readiness, and a nonempty eligible audience. Snapshot recipients, record launch/idempotency key, transition campaign state, and enqueue dispatch in a consistent database transaction. pg-boss documents enqueuing within an existing transaction; if library/version constraints prevent that, use an application outbox in the same transaction and a dispatcher that retries enqueue. Never create a campaign with no durable dispatch path.

**Per-recipient worker:** Atomically claim one pending recipient, check campaign state and current suppression/consent for the **exact snapshotted destination** immediately before send, and invalidate a pending recipient if that contact's phone changed. Verify template freshness for the batch, evaluate rate allowance, record an attempt, call Meta, and persist the response. Use a unique `(campaign, contact)` row and attempt sequencing so queue redelivery cannot send the same recipient twice in ordinary retry cases. Do not hold a database transaction open across a network call. Small batches bound memory and permit pause/cancel checks between recipients.

**Rate limiting:** Enforce configurable per-phone concurrency and throughput, a portfolio-level rolling allowance, and recipient-pair constraints according to the live account; react to Meta's 429/limit errors and `Retry-After` when present. Apply a conservative initial ceiling until the actual coexistence/number limits are verified. Add a business-configured quiet-hours policy before release; do not assume all contacts share the restaurant's time zone. Show estimated campaign cost and allowance as an estimate, never a guarantee; Meta's [pricing information](https://whatsappbusiness.com/resources/faq/) must be checked against the account and current rate card.

**Retry classes:** Classify using both HTTP status and Meta error code/context; some limit errors are returned with HTTP 400. Retry verified transient failures with capped exponential backoff and jitter, bounded attempt count, and dead-letter review. Do not retry permanent or policy/quality errors such as invalid number, missing consent, rejected/paused template, or unauthorized account until corrected. A transport timeout **or worker crash/lease expiry after a call may have begun** is `uncertain`: on recovery, park the recipient and reconcile using stored request context/webhook evidence rather than automatically resending. If no reliable reconciliation exists, require an authorized operator decision; external exactly-once delivery cannot be promised. Operator redrive must recheck consent and campaign state. [Meta error-code reference](https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes) needs live verification during implementation.

**Pause/cancel:** Pause stops new claims and waits for active calls to finish; cancel marks unclaimed recipients canceled and stops further dispatch. Recheck state just before the external call. There is a small unavoidable in-flight window; sends already accepted by Meta cannot be withdrawn. Resume only remaining eligible recipients and revalidate the template/allowance. Display state transitions and audit who changed them.

**Queue operations:** pg-boss jobs are at-least-once work triggers, not the source of truth. Monitor backlog, oldest pending age, attempt counts, dead letters, scheduler lag, DB load, and worker health. Use a separate worker process with graceful shutdown and safe restart. Pg-boss retry and dead-letter policies are documented in its [queue guide](https://github.com/timgit/pg-boss/blob/master/docs/api/queues.md); handlers remain idempotent even if a worker is incorrectly considered dead and work is redelivered.

## 10. Authentication, authorization, and secrets

- **Proposed roles:** `owner` manages staff, sender settings, and launch rights; `manager` manages contacts/consent, templates, campaigns, and analytics; `marketer` drafts/reviews campaigns and views scoped reports, with launch permission explicitly configurable; `viewer` is read-only. Exact rights require client approval. Default deny.
- **Identity:** Supabase Auth email/password sign-in is wired for existing users, and the dashboard verifies the current user and staff role or confirmed admin allowlist on the server. Admin-only direct account creation uses a server-only Supabase secret key; each new account is tagged with server-managed `app_metadata.role = "staff"`. Before release, define additional roles, MFA policy, session lifetime and revocation review, and sign-in audit records. No public signup is exposed by this app.
- **Authorization:** Validate session and role inside each server service/Route Handler or Server Action. A hidden button or layout redirect is not authorization. Export, CSV import, template sync, launch, and consent changes merit elevated permissions and audit entries.
- **Secrets:** Keep Meta system-user token, app secret, webhook verify token, database credentials, and auth keys in a managed secret store. Never expose them through `NEXT_PUBLIC_*`, browser bundles, CSV exports, logs, source control, or this document. Give web and worker separate least-privilege identities; rotate and revoke credentials under an operations runbook.
- **Data protection:** HTTPS/TLS, encryption at rest, restricted database network access, backup encryption, role-scoped access to phone data, masking in UI/logs, import/export limits, audit trails, dependency and secret scanning in CI. Do not log full webhook bodies or tokens. Restrict diagnostic payload retention and access.

## 11. Consent, opt-outs, privacy, and compliance

**Meta policy:** The [WhatsApp Business Messaging Policy](https://whatsappbusiness.com/policy/) requires the person to have provided their number/username and opted in to receive subsequent messages; it requires honoring opt-outs on and off WhatsApp, and approved templates for business-initiated messages. [Meta's marketing guidance](https://whatsappbusiness.com/wp-content/uploads/2026/04/Best-Practices-for-Marketing-Messages-on-WhatsApp-.pdf) does not make a distinct WhatsApp-specific opt-in form universally mandatory; **proposed product policy** is to collect explicit, purpose-specific WhatsApp marketing consent because it is easier to evidence and safer for this Canadian use case.

**Canadian context:** CRTC guidance says commercial electronic messages to electronic addresses, including text/mobile messaging, generally require consent, sender identification, and a working unsubscribe mechanism. The sender must be able to prove consent and must honor unsubscribe requests within the legal deadline; implied-consent rules are fact-specific and time-limited. See the [CRTC CASL guide](https://crtc.gc.ca/eng/com500/guide.htm) and [FAQ](https://crtc.gc.ca/eng/com500/faq500.htm/). The [Office of the Privacy Commissioner](https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/r_o_p/canadas-anti-spam-legislation/casl-compliance-help-for-businesses/casl_guide/) flags instant-message marketing and vendor-provided-list risks. This plan is technical guidance, not a legal opinion; Canadian counsel should review consent wording, audience provenance, sender identification, unsubscribes, privacy notice, retention, and cross-border disclosures before production marketing.

**Enforcement design:**

- Record the exact consent notice/version, source/form or event, timestamp, purpose, phone, and evidence reference. No prechecked consent boxes and no automatic consent from a purchase, website visit, app chat, or CSV upload.
- Treat imported consent as unverified until a staff reviewer checks source evidence. Separate unknown, opted-in, revoked, and suppressed states. Never send to unknowns. Keep grant/revocation history immutable while limiting personal details.
- Put the business identity and a simple opt-out instruction in the approved template design, and handle replies/manual requests quickly. A recognized webhook opt-out is durably suppressed before acknowledgment; the next send-time check blocks pending work. Already in-flight Meta calls cannot be recalled.
- Check suppression at campaign creation, launch, and immediately before each external API call. Stop pending jobs when a phone or mapped provider identity opts out; never re-enable on import. Re-consent needs new affirmative evidence and authorized review.
- Define a retention/deletion schedule for contacts, raw CSVs, webhook payloads, logs, and proof records with counsel. Support access/deletion requests while retaining the minimum suppression and compliance evidence legally needed; avoid rebuilding consent from analytics after deletion.
- Define where data, backups, and logs reside and document Meta and identity-provider transfers. A Canada-region database alone does not mean end-to-end Canadian data residency.

## 12. Dashboard pages and staff workflow

| Page | Core workflow |
| --- | --- |
| Overview | Today’s scheduled/running campaigns, send health, queue backlog, webhook freshness, top-level metrics, action alerts. |
| Contacts / Import | Search and edit; upload CSV; map columns; inspect normalization, duplicates, rejected rows and consent evidence; approve import. |
| Segments | Build validated rules, preview eligible count, save versions. |
| Templates | Sync Meta templates, filter by language/category/status, preview placeholders and approval changes. |
| Campaigns / New | Select sender/template/segment, map variables, preview, review eligible/suppressed counts and estimated cost, select schedule, require launch confirmation. |
| Campaign detail | Timeline, counts, recipient outcomes, errors/unknowns, pause/resume/cancel, safe retry/reconciliation review, export within role limits. |
| Analytics | Delivery funnel and trends with clear denominator definitions; differentiate submitted/accepted/sent/delivered/read/failed. |
| Settings | Team roles, WhatsApp account health, webhook health, consent policy, audit access; never display tokens. |

Flow: staff drafts a campaign → server validates and snapshots the segment/approved template → authorized user schedules or launches → worker claims due batches → every recipient passes a fresh consent/suppression check → Cloud API accepts or rejects the template send → Meta webhooks update the event timeline and current state → dashboard reports status and exceptions. The UI must show that `accepted` is not `delivered`.

## 13. Testing and deployment plan

**Tests after implementation approval:** Unit tests for phone normalization, consent precedence, segment filters, DST scheduling, role policy, and status transitions. Integration tests with PostgreSQL/queue for unique recipients, transactional launch, concurrent claims, pause/cancel, retries, dead-letter, opt-out races, webhook signature failure/replay/out-of-order/missing IDs, and ambiguous send handling. API contract tests with sanitized Meta fixtures and mocked Graph responses. End-to-end tests for staff import → segment → template preview → draft → launch → monitor, using synthetic data only. A staging Meta account/test number should validate onboarding, template sync, signed webhooks, and limited sends before any production audience. Restore backups and test worker restart recovery. Do not run live marketing as a test.

**Proposed deployment:** One repository/build with separate web and worker process commands; AWS ECS Fargate in `ca-central-1` is the preferred target, with RDS PostgreSQL, Secrets Manager, HTTPS ingress, private database networking, encrypted backups/PITR, and centralized metrics/logs/alerts. Use distinct development, staging, and production configurations and Meta assets where feasible. CI should run type checks, lint, tests, migration review, and vulnerability/secret checks; production migration and deployment require a controlled release/rollback plan. Keep a documented on-call owner for webhook/queue outages and a database restore exercise. Estimate cloud and Meta message cost before procurement. No hosting resources have been created.

## 14. Phases, dependencies, and acceptance criteria

| Phase | Scope | Exit / acceptance criteria |
| --- | --- | --- |
| 0. Decisions and readiness | Confirm consent policy, data source/evidence, team identity, budget, actual Meta account and coexistence eligibility. | Written decisions on open questions; authorized Meta administrator confirms number onboarding path, WABA, permissions, billing, limits, and test assets. No production sends. |
| 1. Foundation | Initialize Next.js/TypeScript, DB schema/migrations, auth/RBAC, audit, CI, staging, secrets, backups. | Staff can be added directly by an admin and sign in; unauthorized reads/mutations are denied; schema deploy/restore tested. |
| 2. Contact/consent/template MVP | Contact CRUD, validated CSV import, suppression, template sync/preview, segmentation basics. | No contact without documented consent is eligible; import errors are reviewable; only approved templates appear as sendable. |
| 3. Controlled campaigns and webhooks | Draft/review/schedule, recipient snapshot, worker queue/rate limit, pause/cancel, send attempts, verified webhook inbox, urgent opt-out and status processing. | Synthetic/staging campaign sends to a tiny approved test audience; duplicate dispatch, webhook replay, and opt-out race tests pass; failures and uncertainty visible. |
| 4. Analytics and launch | Dashboards, operational alerts, security review, backup/worker recovery, pilot. | Replay/out-of-order events remain safe; dashboard distinguishes acceptance from delivery; manual incident runbook tested; client approves production pilot. |
| 5. Growth | Advanced segments, richer analytics, performance tuning, optional additional senders. | Add only against measured use, documented limits, and revised cost/operations plan. |

**MVP boundary:** One business, one approved sender if eligible, admin-created staff, simple saved segments, evidenced consent, approved template sync/preview, scheduled campaigns, safe queue sends, signed webhooks, pause/cancel, basic recipient-level analytics, and audit. Advanced personalization, A/B testing, multiple tenants, chatbot conversations, and marketing attribution are later scope.

### Main risks and mitigations

| Risk / dependency | Mitigation or gate |
| --- | --- |
| Existing Business App number cannot use coexistence in this account or chosen onboarding route | Verify account-specific eligibility before implementation or number changes; client chooses fallback. |
| Imported list lacks defensible marketing opt-in | Quarantine ineligible rows; secure source evidence or obtain new compliant opt-in before send. |
| Template/category/quality or portfolio limits block delivery | Read current Meta state, monitor quality and errors, cap rate, and pilot small. No hardcoded tiers. |
| Network timeout or worker crash causes unknown send outcome | Mark uncertain, reconcile and require controlled operator review; never blind-retry possible acceptance. |
| Webhook downtime or replay corrupts analytics | Signed durable inbox, dedupe, replay-safe state projection, alerts, and reconciliation procedure. |
| Worker/DB load or scheduling drift | Bounded batches, indexes, metrics, capacity test, persisted schedules, recovery runbook. |
| Personal-data or credential exposure | Least privilege, secret manager, minimized logs/retention, encryption, role checks, security review. |
| Cost or residency assumptions prove wrong | Confirm hosting, identity, Meta rate card and data-flow locations before procurement and production. |

## 15. Questions requiring the client's decision before coding or live setup

1. **Who owns the Meta business portfolio, WABA, app, Business App number, and billing?** Can the authorized admin provide a non-secret account inventory and verify the number's coexistence eligibility through Meta's current onboarding process? Do not send credentials in chat or documents.
2. **What is the provenance of the contact list and WhatsApp marketing consent?** Which collection form, exact notice, timestamp, and evidence exist per contact? Is a new opt-in flow needed before any campaign?
3. **What is the launch scope?** Expected contact count, daily/peak sends, number of concurrent campaigns, languages, staff users/roles, and whether there will ever be more than one business/sender.
4. **What approval workflow is required?** May a marketer launch, or must a manager/owner approve each campaign? Who can pause, cancel, redrive, export, and override a disputed consent record?
5. **What sending schedule is acceptable?** Default time zone, quiet hours, weekends/holidays, schedule precision, and how to handle recipients outside Ontario or unknown local time.
6. **Which staff identity provider and MFA policy should be used?** Google Workspace, Microsoft Entra, another OIDC provider, or an approved fallback?
7. **What hosting budget and data-location obligations apply?** Is Canada-only storage required for database/backups/logs, and what cross-border Meta/identity-provider processing is acceptable? Who will own AWS operations and incident response?
8. **What are the retention and privacy policies?** How long keep raw imports, consent proof, suppression records, webhook payloads, message events, and audit logs? Who handles privacy/deletion requests and legal review?
9. **Which approved templates and brand wording are ready?** Required languages, variable sources, sender identity, unsubscribe phrase, and any content-approval process.
10. **What defines success for the pilot?** Target cohort, allowable failed/unknown rate, reporting metrics, launch date, and rollback threshold.

## 16. Reference check and implementation note

The links above are official project/vendor/regulator sources where possible. Meta developer pages for coexistence and messaging limits could not be fully fetched during this review; verify the live pages and the actual account with an authorized administrator before implementation. Meta terms, Graph versions, pricing, and limits change. The business backend, migrations, and Meta integration described here remain future work.
