# Tests

Run the synthetic file import, Meta client/webhook, and campaign worker tests with:

```powershell
node --test tests/unit/contact-import.test.cjs tests/unit/campaign-worker.test.cjs tests/unit/meta-client.test.cjs tests/unit/meta-whatsapp.test.mjs
```

These tests mock external Meta responses and use synthetic contacts. They do not send messages or connect to the configured Supabase project. Apply and verify the SQL migrations separately before live use.
