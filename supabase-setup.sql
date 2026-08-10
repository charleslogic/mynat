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
-- exclude_taxon_id supports paraphyletic splits where the "obvious" group
-- isn't its own clade — e.g. Moths has no taxon ID of its own; it's
-- Lepidoptera (47157) minus Papilionoidea (47224), a specific superfamily
-- nested inside it, not a sibling. Lizards/Snakes don't need this: Sauria
-- and Serpentes are siblings under Squamata, so each is already a clean,
-- non-overlapping group on its own.
create table if not exists mynat_category_shortcuts (
  label text primary key,
  taxon_id int not null,
  exclude_taxon_id int,
  created_at timestamptz default now()
);
alter table mynat_category_shortcuts add column if not exists exclude_taxon_id int;

-- Seed data — every ID here was looked up against the live API
-- (GET /v1/taxa/{id} and /v1/taxa?q=...) and cross-checked against real
-- synced observations (e.g. Butterflies + Moths-excl-Butterflies summed to
-- exactly the Lepidoptera total) before being hardcoded, per the dev plan's
-- explicit warning not to trust taxon IDs from memory. One example of why:
-- the dev plan's own draft guess of 26718 for "Lizards" turned out to
-- actually be Caudata (Salamanders) — the real Lizards ID is 85552 (Sauria).
insert into mynat_category_shortcuts (label, taxon_id, exclude_taxon_id) values
  ('Butterflies', 47224, null),   -- Papilionoidea
  ('Moths', 47157, 47224),        -- Lepidoptera minus Papilionoidea
  ('Lizards', 85552, null),       -- Sauria
  ('Snakes', 85553, null)         -- Serpentes
on conflict (label) do update set
  taxon_id = excluded.taxon_id,
  exclude_taxon_id = excluded.exclude_taxon_id;

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
