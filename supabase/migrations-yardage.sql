-- Yardage per hole. Run once in Supabase: Dashboard > SQL Editor > New query > paste > Run.
-- Safe to run more than once.

alter table public.rounds         add column if not exists yardages jsonb;  -- array of ints (or null per hole), one per hole played
alter table public.courses        add column if not exists yardages jsonb;
alter table public.pending_scores add column if not exists yardages jsonb;

-- Accepting a tagged score now copies yardages too.
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

  insert into public.rounds (course, played_on, tees, holes, score, rating, slope, putts, hole_scores, pars, yardages)
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
    case when r ? 'pars' then nullif(r->'pars', 'null'::jsonb) else ps.pars end,
    case when r ? 'yardages' then nullif(r->'yardages', 'null'::jsonb) else ps.yardages end
  )
  returning id into new_id;

  update public.pending_scores set status = 'accepted', decided_at = now() where id = p_id;
  return new_id;
end;
$$;
revoke all on function public.accept_pending_score(uuid, jsonb) from public, anon;
grant execute on function public.accept_pending_score(uuid, jsonb) to authenticated;
