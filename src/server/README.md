# Server-only modules

- `auth`: staff sessions, admin-only direct account creation, and future role policy.
- `db`: schema, connection, repositories, and transaction helpers.
- `meta`: Cloud API client, template mapping, and webhook verification.
- `services`: contact, consent, segment, campaign, and analytics rules.
- `jobs`: queue setup, scheduler, handlers, and rate controls.
- `security`: input limits, audit records, and secret access.
- `observability`: structured logs, metrics, and alerts.

Keep Meta tokens and database credentials in managed secrets. UI and route handlers call these modules; the worker reuses them. The full design is in the root `context.md`.
