-- Shared gate activity log — run once in the Supabase SQL editor. This is
-- the same physical shared project (nfvxmkknkxysjksyhbek) used by every app,
-- so running this once (from any single app's copy of this file) covers all
-- of them. A copy of this file lives in every gated app's repo for
-- discoverability, but it's idempotent — safe to run again from another copy
-- later, it'll just no-op.
--
-- Populated by each app's middleware.js (see "Access Gate" in CLAUDE.md).

create table if not exists gate_log (
  id bigint generated always as identity primary key,
  app text not null,
  event text not null check (event in ('view', 'attempt_ok', 'attempt_fail')),
  ip text,
  country text,
  path text,
  user_agent text,
  key_tried text,
  created_at timestamptz not null default now()
);

create index if not exists gate_log_app_created_idx on gate_log (app, created_at desc);
create index if not exists gate_log_ip_created_idx on gate_log (ip, created_at desc);

alter table gate_log enable row level security;

-- Anon (the public key embedded client-side) can only ever insert — never
-- read, update, or delete. Query the table directly via the Supabase SQL
-- editor (runs as a privileged role, bypasses RLS).
create policy "gate_log anon insert" on gate_log
  for insert
  to anon
  with check (true);

-- Example queries:
--
-- Activity per app, last 7 days:
--   select app, event, count(*) from gate_log
--   where created_at > now() - interval '7 days'
--   group by app, event order by app, event;
--
-- Most persistent IPs across all apps ("effort"):
--   select ip, count(*) filter (where event = 'attempt_fail') as fails,
--          count(*) filter (where event = 'view') as views,
--          min(created_at) as first_seen, max(created_at) as last_seen
--   from gate_log group by ip order by fails desc limit 50;
--
-- What keys people are actually guessing:
--   select key_tried, count(*), array_agg(distinct ip) as ips
--   from gate_log where event = 'attempt_fail'
--   group by key_tried order by count(*) desc limit 50;
