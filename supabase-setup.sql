-- MyNat — Supabase setup
-- Run once in the Supabase SQL editor for the shared project nfvxmkknkxysjksyhbek:
-- https://supabase.com/dashboard/project/nfvxmkknkxysjksyhbek/sql
--
-- All tables use the mynat_ prefix to coexist with other apps in the shared project.

-- ── Profiles ──────────────────────────────────────────────────────────────────
-- Links a Supabase auth user to their iNaturalist account.
create table if not exists mynat_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  inat_username text not null,
  inat_user_id int,             -- resolved from iNat on first link (GET /v1/users/autocomplete)
  last_synced_at timestamptz,   -- drives incremental sync (?updated_since=)
  created_at timestamptz default now()
);

-- ── Observations ──────────────────────────────────────────────────────────────
-- One row per iNat observation, owned by the linking app user.
create table if not exists mynat_observations (
  inat_id bigint primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  taxon_id int,
  scientific_name text,
  common_name text,
  iconic_taxon text,             -- Aves, Insecta, Fungi, etc. (broad bucket, fast filter)
  ancestor_ids int[],            -- full lineage, e.g. [1,47120,47158,47157,47224] for a butterfly
  taxon_rank text,               -- species, genus, family...
  observed_on date,
  time_observed_at timestamptz,
  latitude double precision,
  longitude double precision,
  place_guess text,
  quality_grade text,            -- research, needs_id, casual
  photos jsonb,                  -- array of {url, square, small, medium, large, original}
  inat_updated_at timestamptz,   -- iNat's own updated_at, used for sync diffing
  created_at timestamptz default now()
);

create index if not exists idx_mynat_obs_user on mynat_observations(user_id);
create index if not exists idx_mynat_obs_ancestors on mynat_observations using gin(ancestor_ids);
create index if not exists idx_mynat_obs_iconic on mynat_observations(user_id, iconic_taxon);
create index if not exists idx_mynat_obs_date on mynat_observations(user_id, observed_on desc);
create index if not exists idx_mynat_obs_search on mynat_observations using gin(
  to_tsvector('english', coalesce(common_name,'') || ' ' || coalesce(scientific_name,''))
);
create index if not exists idx_mynat_obs_geo on mynat_observations(latitude, longitude);

-- ── Category shortcuts (optional, shared reference data — not per-user) ───────
-- Friendly labels mapped to iNat taxon IDs, e.g. ('Butterflies', 47224).
-- Populate once real taxon IDs are confirmed against the live iNat API — see
-- "Open Questions" in the dev plan before trusting any IDs from memory here.
create table if not exists mynat_category_shortcuts (
  label text primary key,
  taxon_id int not null,
  created_at timestamptz default now()
);

-- ── Row Level Security ───────────────────────────────────────────────────────
-- user_id = auth.uid() is the entire isolation boundary (hab_habits/hab_scores
-- pattern) — no intermediate join through profiles for authorization.
alter table mynat_profiles enable row level security;
alter table mynat_observations enable row level security;
alter table mynat_category_shortcuts enable row level security;

drop policy if exists "own profile" on mynat_profiles;
drop policy if exists "own observations" on mynat_observations;
drop policy if exists "category shortcuts read" on mynat_category_shortcuts;

create policy "own profile" on mynat_profiles
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own observations" on mynat_observations
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Shared reference data: any authenticated user can read, nobody writes via
-- the client (you populate it directly via the SQL editor).
create policy "category shortcuts read" on mynat_category_shortcuts
  for select
  to authenticated
  using (true);
