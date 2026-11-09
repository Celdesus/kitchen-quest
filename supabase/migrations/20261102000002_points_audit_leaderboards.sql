-- Points (awarded on sign-off only, reversible by new rows), audit log, leaderboards, streaks, crowns.
-- All day/week boundaries are computed explicitly in Australia/Perth (AWST, UTC+8, no DST), never server time.
-- Game week: Monday 00:00:00 to Sunday 23:59:59 AWST (date_trunc('week') is ISO, i.e. Monday-based).
-- Scales with no schema change: outlets, sections and staff are all rows, nothing is hard-coded.

create function public.perth_today() returns date language sql stable as $$
  select (now() at time zone 'Australia/Perth')::date $$;
create function public.perth_week_start(ts timestamptz default now()) returns date language sql stable as $$
  select date_trunc('week', ts at time zone 'Australia/Perth')::date $$;

-- Award on sign-off; if a sign-off is withdrawn, add a reversal row (the ledger is never edited)
-- A week is LOCKED for an outlet once the owner has signed off that outlet's crown OR the group crown for that week
-- (the group board includes every outlet's points and hours).
create function public.week_locked(p_outlet smallint, p_week date) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.weekly_crowns c
                  where c.week_start = p_week and c.status = 'confirmed' and (c.outlet_id = p_outlet or c.outlet_id is null));
$$;

-- Hours entry window: past weeks any time (until locked); the CURRENT week opens Sunday 18:00 AWST
-- (Ivan's reminder is Sunday 21:00 AWST). Winners still calculate Monday 00:00 AWST. Future weeks never.
create function public.hours_entry_opens_at(p_week date) returns timestamptz
language sql immutable as $$ select ((p_week + 6) + time '18:00') at time zone 'Australia/Perth' $$;
create function public.hours_entry_open(p_week date, p_at timestamptz default now()) returns boolean
language sql stable as $$ select p_at >= public.hours_entry_opens_at(p_week) $$;

-- Ledger weeks: never change a signed-off week. Late approvals (and reversals of points in a signed-off week)
-- are credited to the current open week; original_week keeps the week the job was actually done.
create function public.ledger_set_weeks() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.reverses_id is not null then
    select credited_week into new.original_week from public.points_ledger where id = new.reverses_id;
  elsif new.completion_id is not null then
    select public.perth_week_start(c.completed_at) into new.original_week from public.completions c where c.id = new.completion_id;
  end if;
  new.original_week := coalesce(new.original_week, public.perth_week_start(new.awarded_at));
  new.credited_week := case when public.week_locked(new.outlet_id, new.original_week)
                            then greatest(public.perth_week_start(), new.original_week) else new.original_week end;
  if new.credited_week <> new.original_week then
    new.reason := new.reason || ' (week of ' || to_char(new.original_week, 'FMDD Mon') || ' already signed off, so credited to this week)';
  end if;
  return new;
end $$;
create trigger ledger_weeks before insert on public.points_ledger
for each row execute function public.ledger_set_weeks();

create function public.award_points_on_review() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_points int; v_title text; v_outlet smallint; v_net int; v_award bigint;
begin
  select coalesce(sum(points), 0) into v_net from public.points_ledger where completion_id = new.id;
  if new.status = 'approved' and v_net = 0 then
    select j.points, j.title, j.outlet_id into v_points, v_title, v_outlet
      from public.assignments a join public.jobs j on j.id = a.job_id where a.id = new.assignment_id;
    insert into public.points_ledger (staff_id, outlet_id, entry_type, points, reason, completion_id, awarded_by, awarded_at)
    values (new.staff_id, v_outlet, 'award', v_points, 'Job signed off: ' || v_title, new.id, new.reviewed_by, coalesce(new.reviewed_at, now()));
  elsif new.status <> 'approved' and v_net <> 0 then
    select l.id into v_award from public.points_ledger l
     where l.completion_id = new.id and l.entry_type = 'award'
       and not exists (select 1 from public.points_ledger r where r.reverses_id = l.id)
     order by l.id desc limit 1;
    if v_award is not null then
      insert into public.points_ledger (staff_id, outlet_id, entry_type, points, reason, completion_id, reverses_id, awarded_by)
      select staff_id, outlet_id, 'reversal', -points, case when new.status = 'reversed' then 'Reversed: ' else 'Sign-off withdrawn' end || coalesce(case when new.status = 'reversed' then '' else ': ' end || new.review_note, ''), new.id, id, new.reviewed_by
        from public.points_ledger where id = v_award;
    end if;
  end if;
  return new;
end $$;
create trigger completions_award after insert or update of status on public.completions
for each row execute function public.award_points_on_review();

-- Ledger is append-only (the only allowed update is the FK nulling completion_id when a job is deleted)
create function public.ledger_append_only() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.completion_id is null
     and (to_jsonb(new) - 'completion_id') = (to_jsonb(old) - 'completion_id') then
    return new;
  end if;
  raise exception 'Points ledger is append-only: add a reversal entry instead' using errcode = '42501';
end $$;
create trigger ledger_no_edit before update or delete on public.points_ledger
for each row execute function public.ledger_append_only();

-- Audit trigger: who (from the session JWT), when, old and new values
create function public.audit_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_actor uuid;
begin
  select id into v_actor from public.staff where auth_user_id = auth.uid();
  insert into public.audit_log (actor_id, table_name, row_id, action, old_data, new_data)
  values (v_actor, tg_table_name,
          coalesce(to_jsonb(new) ->> 'id', to_jsonb(old) ->> 'id',
                   (to_jsonb(new) ->> 'staff_id') || '/' || (to_jsonb(new) ->> 'outlet_id'),
                   (to_jsonb(old) ->> 'staff_id') || '/' || (to_jsonb(old) ->> 'outlet_id')), tg_op,
          case when tg_op <> 'INSERT' then to_jsonb(old) - 'pin_hash' end,
          case when tg_op <> 'DELETE' then to_jsonb(new) - 'pin_hash' end);
  return coalesce(new, old);
end $$;
create trigger audit_jobs          after insert or update or delete on public.jobs           for each row execute function public.audit_change();
create trigger audit_rewards       after insert or update or delete on public.weekly_rewards for each row execute function public.audit_change();
create trigger audit_crowns        after insert or update or delete on public.weekly_crowns  for each row execute function public.audit_change();
create trigger audit_ledger        after insert                     on public.points_ledger  for each row execute function public.audit_change();
create trigger audit_assignments   after insert or update or delete on public.assignments    for each row execute function public.audit_change();
create trigger audit_staff         after insert or update or delete on public.staff          for each row execute function public.audit_change();
create trigger audit_staff_outlets after insert or update or delete on public.staff_outlets  for each row execute function public.audit_change();
create trigger audit_hours         after insert or update or delete on public.weekly_hours   for each row execute function public.audit_change();
create trigger audit_settings      after insert or update or delete on public.outlet_settings for each row execute function public.audit_change();
create trigger audit_outlets       after insert or update or delete on public.outlets        for each row execute function public.audit_change();
create trigger audit_seasons       after insert or update or delete on public.seasons        for each row execute function public.audit_change();
create trigger audit_review        after update of status           on public.completions    for each row execute function public.audit_change();

-- Leaderboards. outlet_id is null on the group-wide rows. -------------------------------
-- Daily (today, AWST): per outlet, plus group-wide
create view public.leaderboard_daily with (security_invoker = true) as
with pts as (
  select outlet_id, staff_id, sum(points)::int as points from public.points_ledger
   where (awarded_at at time zone 'Australia/Perth')::date = public.perth_today()
   group by grouping sets ((outlet_id, staff_id), (staff_id))
), scope as (
  select so.outlet_id, so.staff_id from public.staff_outlets so
  union all select null, id from public.staff
)
select sc.outlet_id, o.name as outlet, s.id as staff_id, s.name,
       coalesce(p.points, 0) as points,
       rank() over (partition by sc.outlet_id order by coalesce(p.points, 0) desc) as position
  from scope sc join public.staff s on s.id = sc.staff_id
  left join public.outlets o on o.id = sc.outlet_id
  left join pts p on p.staff_id = sc.staff_id and p.outlet_id is not distinct from sc.outlet_id
 where s.active and s.role <> 'owner';   -- staff, leads and managers compete; the owner doesn't

-- Weekly board for every game week and scope (each outlet + group-wide; outlet_id null = group).
-- Ranked on POINTS PER HOUR worked. Outlet: outlet points / hours at that outlet.
-- Group: total points / total hours across all outlets.
-- Unranked (position null) when hours are under that scope's min_hours_to_rank or on approved leave.
-- Ties: more verified jobs, then more deep cleans (v4 rules).
-- Points count in their CREDITED week (see ledger_set_weeks), so a signed-off week never changes.
create view public.weekly_board with (security_invoker = true) as
with led as (
  select l.credited_week as week_start, l.outlet_id, l.staff_id, l.points, l.entry_type,
         (j.kind = 'deep_clean') as is_deep
    from public.points_ledger l
    left join public.completions c on c.id = l.completion_id
    left join public.assignments a on a.id = c.assignment_id
    left join public.jobs j on j.id = a.job_id
), pts as (
  select week_start, outlet_id, staff_id, sum(points)::int as points,
         (count(*) filter (where entry_type = 'award') - count(*) filter (where entry_type = 'reversal'))::int as jobs_verified,
         count(*) filter (where entry_type = 'award' and is_deep)::int as deep_cleans
    from led group by grouping sets ((week_start, outlet_id, staff_id), (week_start, staff_id))
), hrs as (
  select week_start, outlet_id, staff_id, sum(hours) as hours,
         bool_and(leave_status = 'approved_leave') as on_leave
    from public.weekly_hours group by grouping sets ((week_start, outlet_id, staff_id), (week_start, staff_id))
), keys as (
  select week_start, outlet_id, staff_id from pts union select week_start, outlet_id, staff_id from hrs
), base as (
  select k.week_start, k.outlet_id, k.staff_id,
         coalesce(p.points, 0) as points, coalesce(p.jobs_verified, 0) as jobs_verified, coalesce(p.deep_cleans, 0) as deep_cleans,
         coalesce(h.hours, 0)::numeric(6,2) as hours, coalesce(h.on_leave, false) as on_leave,
         coalesce(st.min_hours_to_rank, 10.0) as min_hours,
         case when coalesce(h.hours, 0) > 0 then round(coalesce(p.points, 0) / h.hours, 2) end as points_per_hour
    from keys k
    left join pts p on p.week_start = k.week_start and p.staff_id = k.staff_id and p.outlet_id is not distinct from k.outlet_id
    left join hrs h on h.week_start = k.week_start and h.staff_id = k.staff_id and h.outlet_id is not distinct from k.outlet_id
    left join public.outlet_settings st on st.outlet_id is not distinct from k.outlet_id
), flagged as (
  select b.*, (not b.on_leave and b.hours >= b.min_hours) as ranked,
         case when b.on_leave then 'On approved leave'
              when b.hours = 0 then 'No hours entered'
              when b.hours < b.min_hours then 'Under ' || b.min_hours || ' h minimum' end as unranked_reason
    from base b
)
select f.week_start, f.outlet_id, o.name as outlet, f.staff_id, s.name, s.section_id, sec.name as section,
       (s.started_on > f.week_start - 42) as is_rookie,
       f.points, f.hours, f.points_per_hour, f.jobs_verified, f.deep_cleans, f.on_leave, f.min_hours, f.ranked, f.unranked_reason,
       case when f.ranked then rank() over (partition by f.week_start, f.outlet_id, f.ranked
            order by f.points_per_hour desc, f.jobs_verified desc, f.deep_cleans desc) end as position
  from flagged f join public.staff s on s.id = f.staff_id and s.role <> 'owner'   -- staff, leads and managers all compete; owner (Ivan) excluded
  left join public.outlets o on o.id = f.outlet_id
  left join public.sections sec on sec.id = s.section_id;

-- This week's board (live; hours may still be being entered)
create view public.leaderboard_weekly with (security_invoker = true) as
select * from public.weekly_board where week_start = public.perth_week_start();

-- Section (team) standings this week: section points / section hours, per outlet and group-wide
-- Section (team) board for any week: total points / total hours, so big and small sections compete fairly.
create view public.leaderboard_sections_weekly with (security_invoker = true) as
select b.week_start, b.outlet_id, b.outlet, sec.id as section_id, sec.name as section, sec.colour,
       sum(b.points)::int as points, sum(b.hours) as hours,
       round(sum(b.points) / nullif(sum(b.hours), 0), 2) as points_per_hour,
       rank() over (partition by b.week_start, b.outlet_id order by round(sum(b.points) / nullif(sum(b.hours), 0), 2) desc nulls last) as position
  from public.weekly_board b join public.sections sec on sec.id = b.section_id
 group by b.week_start, b.outlet_id, b.outlet, sec.id, sec.name, sec.colour;

-- Top 3 of every week and scope
create view public.weekly_winners with (security_invoker = true) as
select * from public.weekly_board where position <= 3;

-- Top-3 streaks (v4): consecutive FINISHED weeks finishing in the top 3, one per board (each outlet + group).
-- Weeks where the person is unranked (approved leave, under the minimum hours, or not working there) PAUSE the
-- streak: they neither add to it nor end it. Finishing ranked but outside the top 3 ends it.
-- Milestones 2/4/8/12 weeks map to the streak badges.
create view public.top3_streaks with (security_invoker = true) as
with ranked_weeks as (
  select staff_id, outlet_id, week_start, position <= 3 as top3,
         row_number() over (partition by staff_id, outlet_id order by week_start desc) as rn
    from public.weekly_board
   where ranked and week_start < public.perth_week_start()
), agg as (
  select staff_id, outlet_id,
         coalesce(min(rn) filter (where not top3) - 1, count(*))::int as current_streak,
         max(week_start) filter (where top3) as last_top3_week
    from ranked_weeks group by staff_id, outlet_id
), paused as (
  select b.staff_id, b.outlet_id, bool_or(not b.ranked) filter (where b.week_start = public.perth_week_start() - 7) as paused_last_week
    from public.weekly_board b group by b.staff_id, b.outlet_id
)
select a.staff_id, s.name, a.outlet_id, o.name as outlet, a.current_streak, a.last_top3_week,
       coalesce(p.paused_last_week, false) as paused_last_week,
       case when a.current_streak >= 12 then 'Legend' when a.current_streak >= 8 then 'Unstoppable'
            when a.current_streak >= 4 then 'On Fire' when a.current_streak >= 2 then 'Hot Streak' end as milestone
  from agg a join public.staff s on s.id = a.staff_id
  left join public.outlets o on o.id = a.outlet_id
  left join paused p on p.staff_id = a.staff_id and p.outlet_id is not distinct from a.outlet_id;

-- Seasons must not overlap
create function public.guard_season_overlap() returns trigger language plpgsql set search_path = public as $$
begin
  if exists (select 1 from public.seasons x where x.id <> new.id
               and daterange(x.starts_on, x.ends_on, '[]') && daterange(new.starts_on, new.starts_on + (new.length_weeks * 7 - 1), '[]')) then
    raise exception 'Seasons cannot overlap';
  end if;
  return new;
end $$;
create trigger seasons_no_overlap before insert or update on public.seasons for each row execute function public.guard_season_overlap();

-- Season board: points per hour across the whole season, per outlet and group-wide (same min-hours rule x weeks)
-- Season standing (v7) = total season points / total season hours. Season Champion needs to be ranked
-- (min hours, not on leave) in at least min_ranked_pct of the season's weeks, rounded up (60% -> 6 of 10, 7 of 11, 8 of 12).
create view public.season_board with (security_invoker = true) as
with b as (
  select se.id as season_id, w.outlet_id, w.outlet, w.staff_id, w.name, sum(w.points)::int as points, sum(w.hours) as hours,
         count(*) filter (where w.ranked)::int as weeks_ranked,
         ceil(se.length_weeks * se.min_ranked_pct / 100.0)::int as weeks_needed,
         count(*) filter (where w.position <= 3)::int as top3_weeks, count(*) filter (where w.position = 1)::int as weeks_won
    from public.seasons se join public.weekly_board w on w.week_start between se.starts_on and se.ends_on
   group by se.id, se.length_weeks, se.min_ranked_pct, w.outlet_id, w.outlet, w.staff_id, w.name
)
select b.*, round(b.points / nullif(b.hours, 0), 2) as points_per_hour, b.weeks_ranked >= b.weeks_needed as champion_eligible,
       rank() over (partition by b.season_id, b.outlet_id order by (b.weeks_ranked >= b.weeks_needed) desc,
                    round(b.points / nullif(b.hours, 0), 2) desc nulls last) as position
  from b;

-- Crown sign-off checklist for one outlet (or the group board when p_outlet is null) and week.
-- Shown to the owner before approving; approval WARNS but is never blocked by these.
create function public.crown_readiness(p_outlet smallint, p_week date) returns jsonb
language sql stable set search_path = public as $$
  with scope as (select id from public.outlets where is_active and (p_outlet is null or id = p_outlet)),
  missing as (
    select s.name, o.name as outlet from public.staff_outlets so
      join scope on scope.id = so.outlet_id join public.outlets o on o.id = so.outlet_id
      join public.staff s on s.id = so.staff_id and s.role <> 'owner' and s.active
     where not exists (select 1 from public.weekly_hours h where h.staff_id = so.staff_id and h.outlet_id = so.outlet_id and h.week_start = p_week)
  ), pending as (
    select count(*)::int n from public.completions c join public.assignments a on a.id = c.assignment_id
      join public.jobs j on j.id = a.job_id join scope on scope.id = j.outlet_id
     where c.status = 'pending' and public.perth_week_start(c.completed_at) = p_week
  ), board as (
    select count(*) filter (where ranked)::int ranked, count(*) filter (where not ranked)::int unranked
      from public.weekly_board where week_start = p_week and outlet_id is not distinct from p_outlet
  )
  select jsonb_build_object(
    'missing_hours_count', (select count(*) from missing),
    'missing_hours', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'outlet', outlet) order by outlet, name) from missing), '[]'),
    'pending_count', (select n from pending),
    'ranked_count', (select ranked from board), 'unranked_count', (select unranked from board),
    'all_clear', (select count(*) from missing) = 0 and (select n from pending) = 0)
$$;

create view public.current_season with (security_invoker = true) as
select *, (public.perth_week_start() - starts_on) / 7 + 1 as current_week
  from public.seasons where public.perth_today() between starts_on and ends_on;

-- Pending crowns: for every finished game week (ended Sunday 23:59:59 AWST) and every scope (each outlet + group),
-- record the ranked #1 as 'pending' for the OWNER to confirm or override. Idempotent, so any caller can run it
-- at Monday 00:00 AWST = Sunday 16:00 UTC: the Cloudflare cron Worker (deploy/cron-worker, "0 16 * * SUN"),
-- the Supabase Edge Function (supabase/functions/weekly-crown), or pg_cron. Calling it twice changes nothing.
create function public.crown_weekly_winners() returns integer
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into public.weekly_crowns (outlet_id, week_start, winner_id, auto_winner_id, points, points_per_hour)
  select distinct on (w.outlet_id, w.week_start) w.outlet_id, w.week_start, w.staff_id, w.staff_id, w.points, w.points_per_hour
    from public.weekly_board w
   where w.position = 1 and w.week_start < public.perth_week_start()
     and (w.outlet_id is null or exists (select 1 from public.outlets o where o.id = w.outlet_id and o.is_active))
   order by w.outlet_id, w.week_start, w.jobs_verified desc, w.deep_cleans desc, w.name
  on conflict (outlet_id, week_start) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

