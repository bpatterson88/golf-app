-- Golf Scores database schema.
-- Run this once in Supabase: Dashboard > SQL Editor > New query > paste > Run.
-- Every table uses row-level security, so each signed-in person can only
-- read and change their own rows.

-- Rounds ---------------------------------------------------------------
create table if not exists public.rounds (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  course      text not null check (char_length(course) between 1 and 200),
  played_on   date not null,
  tees        text,
  holes       smallint not null default 18 check (holes in (9, 18)),
  score       smallint not null check (score between 9 and 250),
  rating      numeric(4,1),
  slope       smallint check (slope between 55 and 155),
  putts       smallint,
  hole_scores jsonb,   -- array of ints (or null per hole), one per hole played
  pars        jsonb,   -- array of ints (or null per hole)
  created_at  timestamptz not null default now()
);
create index if not exists rounds_user_idx on public.rounds (user_id, played_on desc);

alter table public.rounds enable row level security;
create policy "rounds: read own"   on public.rounds for select using (auth.uid() = user_id);
create policy "rounds: insert own" on public.rounds for insert with check (auth.uid() = user_id);
create policy "rounds: update own" on public.rounds for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "rounds: delete own" on public.rounds for delete using (auth.uid() = user_id);

-- Saved courses (rating, slope and pars per course + tees + holes) ------
create table if not exists public.courses (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  key        text not null,
  name       text not null,
  tees       text,
  holes      smallint not null default 18 check (holes in (9, 18)),
  rating     numeric(4,1),
  slope      smallint,
  pars       jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.courses enable row level security;
create policy "courses: read own"   on public.courses for select using (auth.uid() = user_id);
create policy "courses: insert own" on public.courses for insert with check (auth.uid() = user_id);
create policy "courses: update own" on public.courses for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "courses: delete own" on public.courses for delete using (auth.uid() = user_id);

-- Per-person settings ---------------------------------------------------
create table if not exists public.profiles (
  user_id     uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  player_hint text,
  updated_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;
create policy "profiles: read own"   on public.profiles for select using (auth.uid() = user_id);
create policy "profiles: insert own" on public.profiles for insert with check (auth.uid() = user_id);
create policy "profiles: update own" on public.profiles for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Photo-read log (used for the daily limit) ------------------------------
-- People can add and read their own entries but never delete them,
-- so the daily limit can't be reset from the app.
create table if not exists public.photo_reads (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists photo_reads_user_idx on public.photo_reads (user_id, created_at desc);

alter table public.photo_reads enable row level security;
create policy "photo_reads: read own"   on public.photo_reads for select using (auth.uid() = user_id);
create policy "photo_reads: insert own" on public.photo_reads for insert with check (auth.uid() = user_id);

-- Chat message log (used for the daily chat limit) -----------------------
-- Same rules as photo_reads: people can add and read their own entries, never delete them.
create table if not exists public.chat_messages (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_user_idx on public.chat_messages (user_id, created_at desc);

alter table public.chat_messages enable row level security;
create policy "chat_messages: read own"   on public.chat_messages for select using (auth.uid() = user_id);
create policy "chat_messages: insert own" on public.chat_messages for insert with check (auth.uid() = user_id);
