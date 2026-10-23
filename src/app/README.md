# App Router

This directory contains the Next.js root `layout.tsx`, Supabase `/sign-in`, a server-protected `/dashboard` shell with no business data yet, and admin-only `/dashboard/users/new` for direct staff account creation. The business dashboard and Route Handlers remain planned. `(auth)` and `(dashboard)` are URL-neutral route groups. `api` is their sibling and will contain public HTTP endpoints, each of which must enforce its own authorization or webhook verification.

Keep domain decisions in `src/server/services`; pages and handlers should validate inputs, call services, and shape responses. The dashboard layout alone must not be treated as an access-control boundary.
