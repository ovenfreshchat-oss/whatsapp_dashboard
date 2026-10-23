# The Oven Fresh dashboard

The staff dashboard includes Meta WhatsApp Cloud API account checks, signed webhook receipt, contact imports, consent review, and reviewed marketing campaign drafts. Bulk sending runs only in a separate worker when its environment switch and sending window are set.

## Local setup

1. Run `npm install`, copy the names in [`.env.example`](.env.example) into `.env`, and add your Supabase and Meta values locally. Keep the secret key, Meta token, app secret, and webhook verify token on the server. `META_TEST_RECIPIENT_E164` is optional and used only for the one-message diagnostic on WhatsApp setup.
2. Apply the SQL files in order to the configured Supabase project: `drizzle/0001_meta_webhook_inbox.sql`, `drizzle/0002_contacts.sql`, `drizzle/0003_campaigns.sql`, then `drizzle/0006_inbox.sql` for the WhatsApp inbox (`0004` and `0005` are small repairs; see the migration README). They have not been applied by this repository. See [drizzle/README.md](drizzle/README.md).
3. Start the dashboard with `npm run dev -- -p 3001` and sign in at `http://localhost:3001/sign-in` with a confirmed staff account. Admin access uses `STAFF_ADMIN_EMAILS` and a confirmed email. The Meta, contacts, and campaigns pages require this admin access.
4. Give Meta a public HTTPS callback. For local testing, run `npm run meta:webhook-proxy` in another terminal. This binds only to `127.0.0.1:3002` and forwards only GET and POST requests for `/api/webhooks/meta/whatsapp` to the dashboard on port 3001. Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/) and run `cloudflared tunnel --url http://127.0.0.1:3002` in a third terminal. [Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) provide a temporary HTTPS URL without an account. In the Meta App dashboard, register `https://YOUR_TUNNEL.trycloudflare.com/api/webhooks/meta/whatsapp` with the same `META_WEBHOOK_VERIFY_TOKEN`, then subscribe to the `messages` webhook field. Keep the dashboard, proxy, and tunnel running; a new tunnel URL must be registered again. For ongoing sending, deploy at a stable public HTTPS address. Keep `WHATSAPP_SENDS_ENABLED=false` during setup.
5. With the public callback responding, subscribe this app to the WABA from this machine:

   ```powershell
   npm run meta:subscribe-webhook -- --callback-url https://YOUR_DOMAIN/api/webhooks/meta/whatsapp
   ```

   The command reads the local `.env`, verifies the public callback's challenge response, sends one `subscribed_apps` request to Meta, and checks that Meta lists `META_APP_ID` afterward. It does not send a WhatsApp message or enable campaigns. It refuses localhost, private addresses, and URLs outside the exact callback path. The system user token needs `whatsapp_business_management` permission and must belong to the configured app. Refresh **WhatsApp setup** after it succeeds; a received webhook is the final delivery check. If the command reports an uncertain result, check the WABA subscription before retrying.

The signed webhook route stores each event durably before acknowledging it. Clear opt-out messages suppress future marketing for that recipient and hold the sender until the recipient identity is reconciled; ambiguous opt-out messages hold the sender for review. The review screen retains a written audit, and clearing a sender hold never removes a recipient opt-out. Keep the webhook endpoint available whenever sending is enabled. See the migration README for raw payload redaction.

## WhatsApp inbox

Open **Inbox** as an admin to read customer WhatsApp messages and reply. Messages are projected into `inbox_conversations` and `inbox_messages` by database triggers on the stored webhook events, so the webhook route is unchanged and a projection error can never block webhook receipt. Applying `drizzle/0006_inbox.sql` also backfills messages already stored.

Replies are free-text and follow WhatsApp's 24-hour customer service window: the composer unlocks only when the customer's last message is under 24 hours old. After that, WhatsApp requires an approved template. The database function `begin_inbox_reply` enforces the window, the customer's opt-out, and any active sender hold under a row lock, and a per-submit token makes double clicks and retries idempotent. A reply whose outcome is uncertain (timeout or 5xx) is marked "Outcome uncertain" and is never retried automatically. Delivery ticks (sent, delivered, read, failed) update from webhook statuses, and a status that arrives before Meta's message ID is stored is replayed afterward.

The page refreshes itself every 10 seconds. Image, audio, location and other non-text messages appear as a placeholder such as `[Image]`; media download is not implemented. Times use `WHATSAPP_SEND_TIME_ZONE` (default UTC). To check the migration, run `tests/unit/inbox-db-check.sql` against an empty scratch Postgres database (see the comment at the top of that file).

## Contacts and consent

Open **Contacts** as an admin. The import form needs only a phone-number column (with `+` country codes). To make the numbers usable in campaigns in one step, tick the confirmation that these people agreed to receive WhatsApp messages from you; this records a verified opt-in naming you and the upload (`drizzle/0007_import_opt_in_attestation.sql`). Numbers that were suppressed, revoked, or replied STOP are never re-enabled by it. For an internal list, set `CONTACT_IMPORT_AUTO_ENABLE=true` in `.env`: every import is then enabled automatically with no tick, and the stored record says it was an automatic enablement without separately verified opt-in. The detailed per-person consent columns and batch review described below still work for files that include them through the API, but the form no longer offers them.

The full file workflow: upload a CSV, `.xlsx`, or `.docx` table with a header row; download a Google Sheet as `.xlsx` or `.csv` first. Map the phone and title/name columns, choose an Excel sheet if needed, and preview the rows. A number must include its `+` country code unless you explicitly choose a default country. Files are capped at 5 MiB and 5,000 rows. Invalid and duplicate rows are skipped, and the import is idempotent.

An optional consent column creates pending claims for explicit “Yes” values. An explicit “No” suppresses that number, including a previously verified contact; a blank cell makes no consent change. Map per-person proof references and consent dates in `YYYY-MM-DD` format, or exact ISO 8601 times with an explicit timezone. Open the import's **Review batch** page to check the evidence, then enter the source and exact WhatsApp marketing notice shown. A date-only claim remains pending until its calendar day has ended worldwide; it keeps date-only precision and uses conservative ordering against opt-outs. The batch action approves only complete claims; incomplete ones remain pending for individual review. If consent evidence is held separately, open that contact's record and record a verified opt-in with those details. A list containing only `Title` and `Number` can be imported, but those contacts are ineligible for marketing until consent is verified. Opt-outs remain suppressed.

## Campaigns and sending

Open **Campaigns** as an admin to choose a live approved marketing template, fill its text variables, and select an audience. The default is the latest uploaded file and includes only its reviewed “Yes” claims that remain eligible. You can deliberately choose all eligible contacts across imports. The draft freezes the chosen audience. Review its recipient preview and template values before scheduling. **Send now** queues the campaign immediately (the worker starts within about a minute); a later schedule only changes database state. Either way, the separate worker performs sends, and only inside its sending window. Campaigns can be paused, resumed, or canceled. Delivery statuses and ambiguous outcomes remain visible for review.

The worker is off by default. To enable it, provide all required Meta and webhook settings plus:

```dotenv
WHATSAPP_SENDS_ENABLED=true
WHATSAPP_SEND_TIME_ZONE=Asia/Kolkata
WHATSAPP_SEND_WINDOW_START=10:00
WHATSAPP_SEND_WINDOW_END=18:00
WHATSAPP_SEND_DAYS=1,2,3,4,5,6
```

Days are `0` (Sunday) through `6` (Saturday). Set the window and days to the business's actual policy; these are examples. Run one supervised worker process per sender using the script documented in [drizzle/README.md](drizzle/README.md). The worker checks the current opt-in, opt-outs, sender holds, app webhook subscription, template approval, and sending window immediately before each Meta POST. Ambiguous send outcomes are parked for reconciliation and are never automatically retried.

No live Meta send or migration was performed during implementation. Production operation still requires the local Meta values, the public HTTPS callback, applied Supabase migrations, and verification with the real account.

## Admin onboarding

Set `STAFF_ADMIN_EMAILS` and `SUPABASE_SECRET_KEY` in `.env`. Run `npm run bootstrap:admin` if the first admin account does not exist, or `npm run reset:admin` to privately reset its password. Signed-in admins can create additional staff accounts from **Add staff user**. The form does not email credentials; share them through a private channel.

See [context.md](context.md) for the larger architecture and decisions still open for the business.
#   w h a t s a p p _ d a s h b o a r d  
 