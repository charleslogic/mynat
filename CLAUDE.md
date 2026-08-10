# MyNat

Browse, map, and search your personal iNaturalist observation history. Multi-user — each
user's data is fully isolated via Supabase Row Level Security. Accounts are created by you
(no self-serve signup): Google OAuth is open to any existing account, email OTP uses
`shouldCreateUser: false`.

Full design rationale and phased build plan: see the dev plan doc (`inat-explorer-dev-plan.md`,
kept outside this repo). This file documents the scaffolding as built, not the roadmap.

## Deploy Workflow

Commit → push to GitHub → Vercel auto-deploys via GitHub integration.
Do **not** use `vercel --prod` directly.

## Browser Testing

The Claude in Chrome extension is paired with Claude Code on this machine (`mcp__claude-in-chrome__*` tools). Use it to verify UI/UX changes live — navigate to the deployed app (or run locally), click through the affected flow, and check console/network output — rather than relying on static analysis alone for frontend changes.

## Architecture

Static `index.html` + one Vercel serverless function. No build step.

```
mynat/
├── index.html            — full app (Supabase auth, tab shell: Overview/Map/List)
├── mynat.js               — app logic (tabs, user menu, apiFetch helper)
├── mynat.css              — styles (theme vars + iconic-taxon category colors)
├── mynat-icon.svg          — app icon (leaf + search loupe)
├── manifest.json          — PWA manifest
├── sw.js                  — service worker (precaches supabase.umd.js, Leaflet + Leaflet.markercluster)
├── supabase.umd.js        — self-hosted Supabase client (never CDN-import)
├── api/
│   └── index.js           — single Vercel function, all actions via ?action=
├── middleware.js           — shared-secret access gate (see below)
├── supabase-setup.sql      — run once in Supabase SQL editor: mynat_profiles, mynat_observations, mynat_category_shortcuts
├── gate_log-setup.sql      — run once in Supabase SQL editor to create the shared gate_log table
├── vercel.json             — security headers
├── package.json            — @supabase/supabase-js + @vercel/edge
└── .env.local.example
```

**1 serverless function** (well within Vercel Hobby 12-function limit). All data operations
(sync, observation queries) go through `api/index.js` via `?action=`, matching `hab`/`wm`.

## Access Gate

`middleware.js` — a plain Vercel Edge Middleware (no framework) gates every request except
`mynat-icon.svg` and `manifest.json`. This is a **shared-secret gate for abuse prevention**,
sitting in front of the real per-user login (see Auth below) — it stops bots/scrapers from
ever reaching the app, the login screen, or burning Vercel function invocations. Same pattern
as nam, hab, wm, annoyed, bikepath, trailview, rad, txparcel, tracklog, debate, ground-truth,
compai, and infer.

- Set `SITE_KEY` in the Vercel project's environment variables to arm it. Unset → fails open
  (lets everyone through) so local dev and misconfigured deploys never lock everyone out.
- Visiting with `?k=<SITE_KEY>` sets a 1-year `httpOnly`/`SameSite=Lax` cookie (`mynat_gate`,
  holds a SHA-256 hash of the key, not the raw key) and redirects to a clean URL. Wrong key
  shows an inline error on the same gate page. No cookie + no key → gate page (`401`).
  Gates `/api/*` too — the middleware runs before the request reaches any route.
- Requires the `@vercel/edge` dependency (`package.json`) for the `next()` helper that
  signals "continue to origin".
- Local dev: copy `.env.local.example` to `.env.local` and set `SITE_KEY` to test the gate,
  or leave it unset to develop without it.

**Activity logging:** every gate hit is logged to a shared `gate_log` table in the same
Supabase project (`gate_log-setup.sql` — idempotent, run once; the table is shared across all
apps that adopt this pattern, distinguished by an `app` column). Logged events: `view` (gate
page shown, no key supplied), `attempt_fail` (wrong key), `attempt_ok` (correct key, right
before the cookie is set) — normal cookie-authenticated requests are **not** logged, only
actual attempts. Each row captures `ip` (from `x-forwarded-for`), `country` (from
`x-vercel-ip-country`), `path`, `user_agent`, and `key_tried`. The insert is fire-and-forget via
`context.waitUntil()` and fails silently if `SUPABASE_URL`/`SUPABASE_ANON_KEY` are unset —
logging can never block or break the gate. `anon` can only `INSERT` into `gate_log` (RLS) —
query it via the Supabase SQL editor; see example queries in `gate_log-setup.sql`.

## Auth

Open multi-user, but not public — accounts are created by you, not self-service. Any existing
account can sign in via Google OAuth (open) or email OTP (`shouldCreateUser: false`, so OTP
alone can't create a new account). Same Supabase project as all other apps
(`nfvxmkknkxysjksyhbek`). RLS (`user_id = auth.uid()` on every table) is the real per-user
isolation boundary — `api/index.js` validates the JWT from the `Authorization` header and
passes the user's token through to Supabase as a user-scoped client, which activates RLS
automatically.

## Environment Variables

Set in Vercel dashboard:

| Variable | Value |
|----------|-------|
| `SUPABASE_URL` | `https://nfvxmkknkxysjksyhbek.supabase.co` |
| `SUPABASE_ANON_KEY` | from Supabase → Settings → API |
| `SITE_KEY` | Shared access-gate key (see Access Gate above) |

No service role key needed — all DB access is JWT-scoped via RLS, including the iNat sync
(Phase 2), which runs as an authenticated action on behalf of the logged-in user.

## Supabase Tables (`mynat_` prefix)

**`mynat_profiles`** — one row per user. `user_id` PK (FK `auth.users`), `inat_username`,
`inat_user_id` (resolved via iNat's `/v1/users/autocomplete`), `last_synced_at` (drives
incremental sync).

**`mynat_observations`** — one row per synced iNat observation. `inat_id` PK, `user_id` FK.
Carries the full `ancestor_ids int[]` taxon lineage (GIN-indexed) so category search ("show me
all butterflies") works at any taxonomic rank without re-querying iNat — this is the core
design idea of the app; see the dev plan section 1 for why `iconic_taxon_name` alone isn't
enough.

**`mynat_category_shortcuts`** — shared reference data (not per-user), friendly label → iNat
taxon ID (e.g. "Butterflies" → 47224). Read-only to authenticated users; populated directly via
the SQL editor. Verify taxon IDs against the live API before adding — don't trust IDs from
memory (see dev plan "Open Questions").

All three tables have RLS enabled. `mynat_profiles`/`mynat_observations`: `user_id = auth.uid()`
on all operations. `mynat_category_shortcuts`: `select` open to `authenticated`, no client writes.

## Build Status

Phase 0 (scaffolding) complete: gate, auth, PWA shell, tab navigation, Leaflet/markercluster
wired in but unused, schema written but not yet run against Supabase. Overview/Map/List tabs
are empty-state placeholders. Next: Phase 1 (schema + the real "connect your iNat username"
flow) — see the dev plan.
