-- Tagging players on a scorecard. Run once in Supabase: SQL Editor > New query > paste > Run.
-- Safe to run more than once.

-- 1. Player list -------------------------------------------------------------
-- One row per app user. Every signed-in user can read it (for the tag picker);
-- each person can only change their own row.
create table if not exists public.players (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 60),
  aliases    text[] not null default '{}',   -- other names or initials they write on cards
  updated_at timestamptz not null default now()
);
alter table public.players enable row level security;
drop policy if exists "players: read all"   on public.players;
drop policy if exists "players: insert own" on public.players;
drop policy if exists "players: update own" on public.players;
create policy "players: read all"   on public.players for select to authenticated using (true);
create policy "players: insert own" on public.players for insert to authenticated with check (auth.uid() = user_id);
create policy "players: update own" on public.players for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

insert into public.players (user_id, name, aliases)
select u.id, v.name, v.aliases
from (values
  ('benpatterson88@gmail.com', 'Ben',    array['B']),
  ('clark.tim.r@gmail.com',    'Tim',    array['T']),
  ('ajh688@gmail.com',         'Andrew', array['A']),
  ('maxjacobs211@gmail.com',   'Max',    array['M'])
) as v(email, name, aliases)
join auth.users u on lower(u.email) = v.email
on conflict (user_id) do nothing;

-- 2. Learned row labels ------------------------------------------------------
-- When someone confirms "TC" on a card is Tim, it's saved here so later guesses improve.
create table if not exists public.row_labels (
  confirmed_by uuid not null default auth.uid() references auth.users (id) on delete cascade,
  label        text not null check (char_length(label) between 1 and 40),  -- lowercased
  user_id      uuid not null references auth.users (id) on delete cascade,
  updated_at   timestamptz not null default now(),
  primary key (confirmed_by, label, user_id)
);
alter table public.row_labels enable row level security;
drop policy if exists "row_labels: read all"   on public.row_labels;
drop policy if exists "row_labels: insert own" on public.row_labels;
drop policy if exists "row_labels: update own" on public.row_labels;
create policy "row_labels: read all"   on public.row_labels for select to authenticated using (true);
create policy "row_labels: insert own" on public.row_labels for insert to authenticated with check (auth.uid() = confirmed_by);
create policy "row_labels: update own" on public.row_labels for update to authenticated using (auth.uid() = confirmed_by) with check (auth.uid() = confirmed_by);

-- 3. Tagged scores waiting for approval --------------------------------------
-- The uploader creates one per tagged player. Only the uploader and the tagged
-- player can see it; only the tagged player can accept or reject it.
create table if not exists public.pending_scores (
  id          uuid primary key default gen_random_uuid(),
  from_user   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  to_user     uuid not null references auth.users (id) on delete cascade,
  course      text not null check (char_length(course) between 1 and 200),
  played_on   date not null,
  tees        text,
  holes       smallint not null default 18 check (holes in (9, 18)),
  score       smallint check (score between 9 and 250),   -- null if the total couldn't be read
  rating      numeric(4,1),
  slope       smallint check (slope between 55 and 155),
  putts       smallint,
  hole_scores jsonb,
  pars        jsonb,
  row_label   text,
  photo_path  text,      -- scorecard photo in the "scorecards" storage bucket
  status      text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz
);
create index if not exists pending_scores_to_idx on public.pending_scores (to_user, status, created_at desc);
alter table public.pending_scores enable row level security;
drop policy if exists "pending_scores: read own"      on public.pending_scores;
drop policy if exists "pending_scores: send"          on public.pending_scores;
drop policy if exists "pending_scores: decide"        on public.pending_scores;
drop policy if exists "pending_scores: cancel unsent" on public.pending_scores;
create policy "pending_scores: read own" on public.pending_scores for select to authenticated
  using (auth.uid() = to_user or auth.uid() = from_user);
create policy "pending_scores: send" on public.pending_scores for insert to authenticated
  with check (auth.uid() = from_user and to_user <> auth.uid() and status = 'pending');
create policy "pending_scores: decide" on public.pending_scores for update to authenticated
  using (auth.uid() = to_user) with check (auth.uid() = to_user);
create policy "pending_scores: cancel unsent" on public.pending_scores for delete to authenticated
  using (auth.uid() = from_user and status = 'pending');

-- Accept a tagged score: copies it (with any edits) into the player's own rounds
-- and marks it accepted, in one step.
create or replace function public.accept_pending_score(p_id uuid, p_round jsonb default null)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  ps public.pending_scores;
  r  jsonb := coalesce(p_round, '{}'::jsonb);
  new_id uuid;
begin
  select * into ps from public.pending_scores
   where id = p_id and to_user = auth.uid() and status = 'pending'
   for update;
  if not found then raise exception 'Tagged score not found or already handled'; end if;

  insert into public.rounds (course, played_on, tees, holes, score, rating, slope, putts, hole_scores, pars)
  values (
    coalesce(nullif(r->>'course', ''), ps.course),
    coalesce((r->>'played_on')::date, ps.played_on),
    case when r ? 'tees' then nullif(r->>'tees', '') else ps.tees end,
    coalesce((r->>'holes')::smallint, ps.holes),
    coalesce((r->>'score')::smallint, ps.score),
    case when r ? 'rating' then (r->>'rating')::numeric else ps.rating end,
    case when r ? 'slope' then (r->>'slope')::smallint else ps.slope end,
    case when r ? 'putts' then (r->>'putts')::smallint else ps.putts end,
    case when r ? 'hole_scores' then nullif(r->'hole_scores', 'null'::jsonb) else ps.hole_scores end,
    case when r ? 'pars' then nullif(r->'pars', 'null'::jsonb) else ps.pars end
  )
  returning id into new_id;

  update public.pending_scores set status = 'accepted', decided_at = now() where id = p_id;
  return new_id;
end;
$$;
revoke all on function public.accept_pending_score(uuid, jsonb) from public, anon;
grant execute on function public.accept_pending_score(uuid, jsonb) to authenticated;

-- 4. Scorecard photos ----------------------------------------------------------
-- Private bucket. Uploaders store photos in a folder named after their user id.
-- A photo can be viewed by its uploader and by anyone tagged on that card.
insert into storage.buckets (id, name, public)
values ('scorecards', 'scorecards', false)
on conflict (id) do nothing;

drop policy if exists "scorecards: upload own" on storage.objects;
drop policy if exists "scorecards: view own or tagged" on storage.objects;
create policy "scorecards: upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'scorecards' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "scorecards: view own or tagged" on storage.objects for select to authenticated
  using (
    bucket_id = 'scorecards' and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (select 1 from public.pending_scores p where p.photo_path = storage.objects.name and p.to_user = auth.uid())
    )
  );
