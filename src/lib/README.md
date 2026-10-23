# Shared utilities

Most utilities here should be small and safe for both browser and server, such as phone formatting, time-zone display, and shared types. `supabase/server.ts` is explicitly server-only and creates a request-scoped Auth client from cookies. Do not import it into browser code. Keep secrets, database clients, and Meta API clients in server modules.
