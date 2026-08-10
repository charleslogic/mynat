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

## API Actions (`/api?action=`)

| Action | Method | Description |
|--------|--------|--------------|
| `version` | GET | No auth — returns `{ok:true}` with `X-App-Version` header. Used by page-load version fetch. |
| `profile` | GET | Current user's `mynat_profiles` row, or `null` if not yet connected. |
| `link-inat` | POST | `{username}` — resolves against iNat's `/v1/users/autocomplete` (exact login match only, fuzzy results rejected), upserts `mynat_profiles`. Re-running with a new username re-links the account. |
| `sync` | POST | `{page}` (default 1) — imports/updates observations for the connected iNat account. See Sync Engine below. |
| `stats` | GET | `{total, speciesCount, earliest, latest, categories}` aggregated from `mynat_observations`. See Overview Stats below. |
| `observations` | POST | `{search, categories, offset}` — paginated (30/page), `observed_on desc` list. See Detail List below. |
| `map` | POST | `{search, categories}` — all matching lat/lng points (unpaginated to the client; paged past PostgREST's 1000-row cap server-side). See Map below. |

## Sync Engine

`syncObservations`, implemented as the `sync` action in `api/index.js`. One code path handles
both the initial full import (`mynat_profiles.last_synced_at` is null) and later incremental
syncs (`&updated_since=<last_synced_at>`) — same request shape either way, just with or without
that query param.

**Resumable, not one-shot.** A single call only walks up to `MAX_PAGES_PER_CALL` (5) pages of
`per_page=200` each, then returns `{imported, page, nextPage, hasMore}`. The client
(`mynat.js: runSync`) loops, calling again with `page: nextPage` until `hasMore` is `false`.
This exists because a real historical import (thousands of observations) would otherwise run
long enough to hit Vercel's function execution time limit — capping each invocation keeps every
round trip fast regardless of account size. `mynat_profiles.last_synced_at` is only written once,
on the call where `hasMore` comes back `false`, so every call in between reads the same
`last_synced_at` cutoff and the incremental window stays consistent across the whole session.

**Pagination caveat:** uses classic `page`/`per_page`, which iNat's API only supports reliably up
to `page * per_page = 10,000` results. Fine for a personal observation history; an account north
of ~10k observations would need `id_above`-based pagination instead (not implemented).

**Field mapping** (`mapObservation`) — verified against live API responses for the connected
test account: `taxon.ancestor_ids` (the full lineage array the whole app's category-search design
depends on), `taxon.iconic_taxon_name`, coordinates from `geojson.coordinates` (falls back to
parsing the `location` "lat,lng" string), and photo URLs via `derivePhotoUrls` — iNat photo URLs
encode their size in the filename (`.../square.jpg`), so other sizes are just that segment
swapped, no extra request needed.

**Triggers:** automatically after a successful `link-inat` (`mynat.js: submitUsername` calls
`runSync()`), and manually via the "Sync now" button in the connected state.

## Overview Stats

The `stats` action (`api/index.js`) pulls `iconic_taxon`, `observed_on`, `taxon_id` from
`mynat_observations` and aggregates in JS — total count, distinct-species count, observed-date
range, and a count per iconic taxon — rather than relying on PostgREST's group-by/aggregate
syntax. Cheap at personal-observation-history scale.

**Row cap bug (fixed):** PostgREST caps an unbounded `select` at 1000 rows by default. The first
version of this action silently undercounted a 1678-observation account as 1000 — caught by
testing against live data, not by code review. Fixed by paging explicitly with `.range()` in
1000-row windows until a short page comes back.

**13 iconic taxa, not 12:** `Animalia` is a real iNat iconic taxon (their "Other Animals"
catch-all — worms, corals, anything not covered by the more specific buckets) and shows up in
real data; it's easy to miss since most summaries of iNat's iconic taxa list only the 12 more
specific ones. `mynat.js: ICONIC_TAXA` and the `--tax-*` CSS variables in `mynat.css` cover all
13 plus an `Unknown` fallback for the null case. Also caught by testing against the live
`@mr-natural` account, not by reading iNat's docs.

**UI** (`mynat.js: renderStats`, `#overview-connected` in `index.html`): 3-stat-card grid
(observations / species / date range) plus a horizontal bar per category, color-coded via
`ICONIC_TAXA`. Refreshed on page load (if connected) and again after every `runSync()`
completes.

**Observations/Species toggle:** the Observations and Species stat cards are clickable
(`data-metric="count"` / `data-metric="speciesCount"`) — clicking switches
`mynat.js: _statsMetric` and re-renders the breakdown (`renderCategoryBreakdown`) sorted and
bar-scaled by that metric instead of refetching. `stats.categories[].speciesCount` (distinct
`taxon_id` per iconic taxon, computed alongside the overall species count via a
`categorySpecies` map in the same `api/index.js` loop) backs this.

**Service worker cache bug (fixed):** `sw.js` originally only treated HTML as network-first;
everything else fell into the cache-first "CDN assets" branch — including same-origin
`mynat.js`/`mynat.css`, which meant every deploy went stale until a hard refresh. `hab` never
hit this because its app logic is inline in `index.html` rather than split into separate files.
Fixed by making the network-first branch match on `url.origin === location.origin` (all
same-origin app files) instead of just HTML, so a normal reload picks up new deploys. Cache
bumped to `mynat-v2` to flush what was already cached under the old strategy.

**Mid-session SW handoff (fixed):** even with the fix above, an already-open tab can still run
old `mynat.js` against a freshly-fetched `index.html` for one reload right as a new SW takes
over (`skipWaiting`/`clients.claim()` hands off control mid-session, not on next navigation) —
this is what caused a one-time "first reload shows the disconnected empty state, second reload
is fine" after the v1→v2 migration. `index.html`'s SW registration now listens for
`controllerchange` and reloads once automatically (guarded by a `refreshing` flag against
looping), so a deploy never needs more than the normal reload going forward.

## Detail List

The `observations` action (`api/index.js`) queries `mynat_observations` directly —
`observed_on desc` with `inat_id desc` as a stable tiebreaker (needed because many observations
share the same date, and `.range()` offset pagination needs a fully deterministic order to avoid
skipping/repeating rows across pages), 30 per page, `count: 'exact'` so the client knows
`hasMore`.

**Filtering:** `categories` (from the shared filter-bar chips, see below) is a plain
`.in('iconic_taxon', categories)` — safe, `.in()` is parameterized by supabase-js. `search`
matches `common_name`/`scientific_name` via `ILIKE '%…%'` rather than the `idx_mynat_obs_search`
tsvector GIN index the schema originally provisioned for this — full-text `tsquery` syntax is
less forgiving for a plain type-and-filter box, and ILIKE is fast enough at personal scale.
Before building the `.or()` filter expression, the search string has `,()` stripped (PostgREST's
`or=` syntax treats those as structural — left raw, a crafted search string could inject
additional filter clauses) and `%_\` escaped (ILIKE wildcards). RLS still bounds every query to
the caller's own rows regardless, but this keeps the query itself well-formed. All three
sanitization/filter paths verified against the live `@mr-natural` account before deploying
(single-category count matched the Overview breakdown exactly; two categories summed correctly;
a comma-and-parens search string returned zero results instead of erroring).

**Shared filter state** (`mynat.js: _listSearch`/`_listCategories`, wired in `initFilterBar`):
lives outside any one tab's code so Map (Phase 5) reuses the same search input and category
chips without duplicating the wiring — `onFiltersChanged()` reloads whichever of List/Map is
currently active. Search is debounced 300ms; category chips are multi-select (OR within
categories, matching the plan's "view birds+mammals together" intent) and reload immediately on
click. Changing filters while on Overview just updates the pending state silently until you
switch to List or Map.

**Cards** (`mynat.js: buildObsCard`) are built with `document.createElement`/`.textContent`, not
`innerHTML` string interpolation — `common_name`, `scientific_name`, and `place_guess` are other
iNat users' free-text data, not just the signed-in user's own, so this isn't optional. Each card
links out to the observation's real iNat page (`inaturalist.org/observations/{inat_id}`).

## Map

`api/index.js`'s `map` action returns every matching point in one response (not paginated to the
client — a map needs the full filtered set to cluster/plot correctly) but pages past PostgREST's
1000-row cap server-side the same way `stats` does, using the same `parseFilterInput`/
`applyObservationFilters` helpers as `observations` so category/search filtering behaves
identically across List and Map. Only `latitude`/`longitude` non-null rows are included (2 of
1678 in the test account lack coordinates). The `thumb` field pulls just the square photo URL out
of the `photos` jsonb array via a PostgREST path selector (`thumb:photos->0->>square`) instead of
the whole array, keeping a ~1700-point response reasonably lean — verified this selector syntax
against live data before deploying.

**Leaflet init** (`mynat.js: initMap`): lazy — created on first Map-tab activation, guarded so a
second visit doesn't re-init (Leaflet throws if you call `L.map()` on an already-initialized
container). Tiles are CartoDB's `dark_all` basemap rather than plain OpenStreetMap (which `hab`
uses) — matches MyNat's dark-first theme and doesn't need an API key; `nam` already established
this as a known-good CDN option elsewhere in the suite. `invalidateSize()` runs once via
`setTimeout(…, 0)` right after creation as cheap insurance against Leaflet reading a zero-size
container, and again every time the tab is reactivated.

**Clustering** (`mynat.js: renderMapMarkers`): builds *two* separate `L.marker` instances per
point — one added to an `L.markerClusterGroup`, one to a plain `L.layerGroup` — rather than
sharing a single instance between them. Leaflet.markercluster mutates the markers it manages
(position/visibility) to draw clusters; sharing an instance would leak that into the flat
individual-markers view. The "Clustered"/"Individual" toggle (`initMapClusterToggle`) just swaps
which group is attached to the map — no refetch, no rebuild. Markers use a colored `L.divIcon`
(`taxonMarkerIcon`, matching `ICONIC_TAXA`) rather than `L.circleMarker`, since markercluster only
clusters marker-like layers, not vector paths. Popups (`buildMapPopup`) are built via DOM APIs for
the same free-text-data reason as list cards, and passed to `bindPopup` as a factory function so
~3350 popup subtrees (2 per point) aren't all built upfront — only on actual open.

**Scaffolding gap found and fixed in this phase:** Phase 0 added the Leaflet/markercluster CDN
`<link>` (CSS) tags and precached the JS in `sw.js`, but never actually added the `<script>` tags
to load `leaflet.js`/`leaflet.markercluster.js` — so `L` was never defined. Added both to
`index.html`'s `<head>`, synchronous, matching `nam`'s convention.

## Build Status

Phase 0 (scaffolding) through Phase 5 (Map) complete — all 5 core phases of the dev plan done.
Live at https://mynat.charleslogic.com/. Overview connects an account and shows real stats;
Detail List and Map both read `mynat_observations` directly through shared search/category
filter state, with Map additionally offering a clustered/individual marker toggle. Remaining
plan items are Phase 6 (curated category shortcuts like "Butterflies" vs "Moths") and Phase 7
(polish — loading states, error handling, mobile responsiveness).
