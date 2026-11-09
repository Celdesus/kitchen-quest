-- Kitchen Quest API as Supabase RPC functions (PostgREST: POST /rest/v1/rpc/<name> with body {"p": {...}}).
-- Every api_* function is SECURITY INVOKER: it runs as the signed-in user, so RLS policies and guard triggers
-- decide exactly as before. The role checks below only add clearer refusal messages (errcode 42501 -> HTTP 403).
-- Logins: staff = tap name + PIN on an outlet tablet (Edge Function "pin-login"); managers/owner = email + password.

-- ---------------------------------------------------------------- logins and tablets
alter table public.staff add column if not exists email text;
create unique index if not exists staff_email_once on public.staff (lower(email)) where email is not null;
comment on column public.staff.email is 'Managers/owner only: their Supabase Auth email (email + password login). Staff use PINs.';

-- One sign-in code per outlet tablet. A manager sets the tablet up once; staff then tap their name + PIN.
-- Without the code, nobody on the internet can list names or try PINs.
create table public.outlet_tablets (
  outlet_id   smallint primary key references public.outlets(id) on delete cascade,
  code        text not null default upper(encode(extensions.gen_random_bytes(6), 'hex')),
  created_by  uuid references public.staff(id) on delete set null,
  created_at  timestamptz not null default now()
);
alter table public.outlet_tablets enable row level security;
create policy tablets_manage on public.outlet_tablets for all to authenticated
  using (public.manages_outlet(outlet_id)) with check (public.manages_outlet(outlet_id));
grant select, insert, update on public.outlet_tablets to authenticated;

-- PIN brute-force protection: 5 wrong PINs locks that person's PIN login for 15 minutes.
create table public.pin_attempts (
  staff_id      uuid primary key references public.staff(id) on delete cascade,
  failures      smallint not null default 0,
  locked_until  timestamptz
);
alter table public.pin_attempts enable row level security;   -- no policies: only the service role (Edge Function) touches it

-- The PIN check is only for the Edge Function (service role). Never callable from the browser.
revoke execute on function public.verify_staff_pin(uuid, text) from anon, authenticated;
grant execute on function public.verify_staff_pin(uuid, text) to service_role;

-- Tablet login screen: names only, only with the outlet's tablet code, only once the outlet is switched on.
create function public.login_roster(p_outlet smallint, p_code text) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when exists (select 1 from public.outlet_tablets t join public.outlets o on o.id = t.outlet_id
                            where t.outlet_id = p_outlet and t.code = upper(trim(p_code)) and o.is_active)
    then coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'section', sec.name) order by s.name)
           from public.staff s join public.staff_outlets so on so.staff_id = s.id and so.outlet_id = p_outlet
           left join public.sections sec on sec.id = s.section_id
          where s.active and s.role = 'staff'), '[]'::jsonb)
    else null end $$;
revoke all on function public.login_roster(smallint, text) from public;
grant execute on function public.login_roster(smallint, text) to anon, authenticated;

-- Used by the pin-login Edge Function (service role only). Returns ok=false instead of raising, so the
-- failure counter is kept. Only role 'staff' (incl. shift leads) logs in by PIN; managers/owner use email + password.
create function public.pin_login_check(p_staff uuid, p_pin text, p_outlet smallint, p_code text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff; a public.pin_attempts;
begin
  if not exists (select 1 from public.outlet_tablets t join public.outlets o on o.id = t.outlet_id
                  where t.outlet_id = p_outlet and t.code = upper(trim(coalesce(p_code, ''))) and o.is_active) then
    return jsonb_build_object('ok', false, 'error', 'This tablet is not set up for that outlet. Ask a manager to set it up.');
  end if;
  select * into s from public.staff where id = p_staff and active and role = 'staff'
     and exists (select 1 from public.staff_outlets so where so.staff_id = p_staff and so.outlet_id = p_outlet);
  if s.id is null then return jsonb_build_object('ok', false, 'error', 'Wrong PIN'); end if;
  select * into a from public.pin_attempts where staff_id = s.id;
  if a.locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'Too many wrong PINs. Try again in 15 minutes or ask a manager.');
  end if;
  if s.pin_hash <> extensions.crypt(coalesce(p_pin, ''), s.pin_hash) then
    insert into public.pin_attempts (staff_id, failures) values (s.id, 1)
      on conflict (staff_id) do update set failures = public.pin_attempts.failures + 1,
        locked_until = case when public.pin_attempts.failures + 1 >= 5 then now() + interval '15 minutes' end;
    update public.pin_attempts set failures = 0 where staff_id = s.id and locked_until is not null and failures >= 5;
    return jsonb_build_object('ok', false, 'error', 'Wrong PIN');
  end if;
  delete from public.pin_attempts where staff_id = s.id;
  return jsonb_build_object('ok', true, 'staff_id', s.id, 'auth_user_id', s.auth_user_id, 'name', s.name);
end $$;
revoke all on function public.pin_login_check(uuid, text, smallint, text) from public, anon, authenticated;
grant execute on function public.pin_login_check(uuid, text, smallint, text) to service_role;

-- Managers/owner: the first email + password sign-in links the Supabase Auth user to their staff row by email.
create function public.link_my_login() returns boolean
language plpgsql security definer set search_path = public, auth as $$
declare v_email text := lower(nullif(auth.jwt() ->> 'email', ''));
begin
  if auth.uid() is null or v_email is null then return false; end if;
  if exists (select 1 from public.staff where auth_user_id = auth.uid()) then return true; end if;
  -- Only a confirmed email (dashboard "Auto Confirm User"), and never take over a row already linked to a live login.
  if not exists (select 1 from auth.users u where u.id = auth.uid() and u.email_confirmed_at is not null) then return false; end if;
  update public.staff s set auth_user_id = auth.uid()
   where lower(s.email) = v_email and s.active and s.role in ('manager', 'owner')
     and not exists (select 1 from auth.users u where u.id = s.auth_user_id);
  return found;
end $$;
revoke all on function public.link_my_login() from public, anon;
grant execute on function public.link_my_login() to authenticated;

-- Only the owner sets login emails (so nobody can attach a login to someone else's profile).
create function public.guard_staff_email() returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') and new.email is distinct from (case when tg_op = 'UPDATE' then old.email end)
     and not public.is_owner() then
    raise exception 'Only the owner can set login emails' using errcode = '42501';
  end if;
  if new.email is not null and new.role = 'staff' then
    raise exception 'Staff log in with a PIN on the outlet tablet; only managers and the owner have email logins' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger staff_email_guard before insert or update of email, role on public.staff
for each row execute function public.guard_staff_email();
grant insert (email), update (email) on public.staff to authenticated;

-- First-time setup on Supabase (run once in the SQL editor): creates Ivan's owner profile for his email login.
create function public.bootstrap_owner(p_name text, p_email text) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare v uuid;
begin
  if exists (select 1 from public.staff where role = 'owner') then raise exception 'An owner already exists'; end if;
  insert into public.staff (name, staff_code, role, email, pin_hash)
  values (p_name, 'OWNER', 'owner', lower(trim(p_email)), extensions.crypt(encode(extensions.gen_random_bytes(16), 'hex'), extensions.gen_salt('bf')))
  returning id into v;
  return v;
end $$;
revoke all on function public.bootstrap_owner(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------- helpers
create function public.kq_scope(v text) returns smallint language sql immutable as $$
  select case when v is null or v in ('', 'group', 'null', 'all') then null else v::smallint end $$;
create function public.kq_deny(msg text) returns void language plpgsql as $$
begin raise exception '%', msg using errcode = '42501'; end $$;
create function public.kq_bad(msg text) returns void language plpgsql as $$
begin raise exception '%', msg using errcode = '22023'; end $$;
create function public.is_reviewer() returns boolean language sql stable security definer set search_path = public as $$
  select public.is_manager() or exists (select 1 from public.staff_outlets so where so.staff_id = public.current_staff_id() and so.is_lead) $$;
create function public.my_role() returns public.staff_role language sql stable security definer set search_path = public as $$
  select role from public.staff where id = public.current_staff_id() $$;
-- Not exposed over HTTP: PostgREST only serves the public schema.
create schema if not exists kq_private;
grant usage on schema kq_private to authenticated;
create function kq_private.kq_rows(q text, a1 text default null) returns jsonb language plpgsql as $$
declare r jsonb;
begin execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from (%s) t', q) into r using a1; return r; end $$;

-- ---------------------------------------------------------------- me
create function public.api_me(p jsonb default '{}') returns jsonb language plpgsql set search_path = public as $$
declare me record;
begin
  perform public.link_my_login();
  select id, name, role, auth.uid() as auth_user_id, nullif(auth.jwt() ->> 'email', '') as email into me from public.staff where id = public.current_staff_id();
  if me.id is null then perform public.kq_deny('This login is not linked to a Kitchen Quest profile. Ask Ivan to add your email.'); end if;
  return jsonb_build_object(
    'user', jsonb_build_object('auth_user_id', me.auth_user_id, 'staff_id', me.id, 'name', me.name, 'role', me.role,
             'email', case when me.role <> 'staff' then me.email end,
             'lead', exists (select 1 from public.staff_outlets so where so.staff_id = me.id and so.is_lead)),
    'outlets', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'is_active', o.is_active, 'rollout_order', o.rollout_order,
                  'is_lead', coalesce(so.is_lead, false), 'manages', public.manages_outlet(o.id)) order by o.rollout_order), '[]')
                from public.outlets o left join public.staff_outlets so on so.outlet_id = o.id and so.staff_id = me.id
               where me.role = 'owner' or so.staff_id is not null),
    'today', public.perth_today(), 'week_start', public.perth_week_start(), 'last_week', public.perth_week_start() - 7);
end $$;

-- ---------------------------------------------------------------- leaderboards, crowns
create function public.api_board(p jsonb default '{}') returns jsonb language plpgsql set search_path = public as $$
declare o smallint := public.kq_scope(p->>'outlet'); w date := coalesce(nullif(p->>'week', '')::date, public.perth_week_start());
begin
  perform public.crown_weekly_winners();   -- lazy catch-up; pg_cron runs it at Monday 00:00 AWST
  return jsonb_build_object('week', w, 'outlet_id', o,
    'rows', (select coalesce(jsonb_agg(to_jsonb(b) order by b.position nulls last, b.points_per_hour desc nulls last, b.name), '[]')
             from public.weekly_board b where b.week_start = w and b.outlet_id is not distinct from o),
    'crown', (select to_jsonb(x) from (select c.*, wn.name as winner_name, a.name as auto_name, ob.name as override_by_name, cb.name as confirmed_by_name
               from public.weekly_crowns c left join public.staff wn on wn.id = c.winner_id left join public.staff a on a.id = c.auto_winner_id
               left join public.staff ob on ob.id = c.override_by left join public.staff cb on cb.id = c.confirmed_by
              where c.week_start = w and c.outlet_id is not distinct from o) x),
    'reward', (select to_jsonb(r) from public.weekly_rewards r where r.week_start = w and r.outlet_id is not distinct from o),
    'streaks', (select coalesce(jsonb_agg(to_jsonb(s) order by s.current_streak desc, s.name), '[]') from
                 (select * from public.top3_streaks where outlet_id is not distinct from o and current_streak > 0 order by current_streak desc, name limit 8) s),
    'sections', (select coalesce(jsonb_agg(jsonb_build_object('section', s.section, 'colour', s.colour, 'points', s.points, 'hours', s.hours,
                   'points_per_hour', s.points_per_hour, 'position', s.position) order by s.position), '[]')
                 from public.leaderboard_sections_weekly s where s.week_start = w and s.outlet_id is not distinct from o),
    'setting', (select to_jsonb(st) from public.outlet_settings st where st.outlet_id is not distinct from o),
    'pending', case when public.is_reviewer() then (select count(*) from public.completions c join public.assignments a on a.id = c.assignment_id
                 join public.jobs j on j.id = a.job_id where c.status = 'pending' and (o is null or j.outlet_id = o)
                  and public.reviews_outlet(j.outlet_id) and c.staff_id is distinct from public.current_staff_id()) end);
end $$;

create function public.api_crowns(p jsonb default '{}') returns jsonb language plpgsql set search_path = public as $$
begin
  perform public.crown_weekly_winners();
  return kq_private.kq_rows($q$select c.*, coalesce(o.name, 'Group-wide board') as scope_name, w.name as winner_name, a.name as auto_name,
          public.crown_readiness(c.outlet_id, c.week_start) as readiness
     from public.weekly_crowns c left join public.outlets o on o.id = c.outlet_id left join public.staff w on w.id = c.winner_id
     left join public.staff a on a.id = c.auto_winner_id where c.week_start = $1::date order by c.outlet_id nulls first$q$, p->>'week');
end $$;

create function public.api_confirm_crown(p jsonb) returns jsonb language plpgsql set search_path = public as $$
declare r jsonb;
begin
  if not public.is_owner() then perform public.kq_deny('Only the owner can do this'); end if;
  -- Missing hours / pending approvals WARN but never block (the app asks "approve anyway?" first)
  r := public.crown_readiness(public.kq_scope(p->>'outlet_id'), (p->>'week_start')::date);
  perform public.confirm_weekly_crown(public.kq_scope(p->>'outlet_id'), (p->>'week_start')::date);
  return jsonb_build_object('ok', true, 'warnings', case when (r->>'all_clear')::boolean then '[]'::jsonb else r end);
end $$;

create function public.api_override_crown(p jsonb) returns jsonb language plpgsql set search_path = public as $$
begin
  if not public.is_owner() then perform public.kq_deny('Only the owner can do this'); end if;
  perform public.override_weekly_crown(public.kq_scope(p->>'outlet_id'), (p->>'week_start')::date, (p->>'winner_id')::uuid, p->>'reason');
  return jsonb_build_object('ok', true);
end $$;

create function public.api_recap(p jsonb) returns jsonb language plpgsql set search_path = public as $$
begin
  if not public.is_manager() then perform public.kq_deny('Managers only'); end if;
  return jsonb_build_object('text', public.publish_weekly_recap(public.kq_scope(p->>'outlet_id'), (p->>'week_start')::date));
end $$;

-- ---------------------------------------------------------------- seasons, outlets, settings
create function public.api_seasons(p jsonb default '{}') returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('seasons', (select coalesce(jsonb_agg(to_jsonb(s) order by s.starts_on desc), '[]') from public.seasons s),
                            'current', (select to_jsonb(c) from public.current_season c limit 1)) $$;

create function public.api_save_season(p jsonb) returns jsonb language plpgsql set search_path = public as $$
declare r public.seasons;
begin
  if not public.is_owner() then perform public.kq_deny('Only the owner can do this'); end if;
  if p ? 'id' and nullif(p->>'id', '') is not null then
    update public.seasons set name = p->>'name', starts_on = (p->>'starts_on')::date, length_weeks = (p->>'length_weeks')::smallint,
           set_by = public.current_staff_id() where id = (p->>'id')::uuid returning * into r;
  else
    insert into public.seasons (name, starts_on, length_weeks, set_by)
    values (p->>'name', (p->>'starts_on')::date, (p->>'length_weeks')::smallint, public.current_staff_id()) returning * into r;
  end if;
  return to_jsonb(r);
end $$;

create function public.api_outlets(p jsonb default '{}') returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.rollout_order), '[]') from (select o.*,
   (select count(*) from public.staff_outlets so join public.staff s on s.id = so.staff_id where so.outlet_id = o.id and s.role = 'staff')::int as staff_count,
   (select count(*) from public.jobs j where j.outlet_id = o.id and j.active)::int as job_count from public.outlets o) x $$;

create function public.api_set_outlet_active(p jsonb) returns jsonb language plpgsql set search_path = public as $$
begin
  if not public.is_owner() then perform public.kq_deny('Only the owner can do this'); end if;
  perform public.set_outlet_active((p->>'id')::smallint, coalesce((p->>'active')::boolean, false));
  return jsonb_build_object('ok', true);
end $$;

create function public.api_settings(p jsonb default '{}') returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.outlet_id nulls first), '[]') from (select st.*, coalesce(o.name, 'Group-wide board') as scope_name
    from public.outlet_settings st left join public.outlets o on o.id = st.outlet_id) x $$;

create function public.api_save_setting(p jsonb) returns jsonb language plpgsql set search_path = public as $$
declare r public.outlet_settings;
begin
  if not public.is_owner() then perform public.kq_deny('Only the owner can do this'); end if;
  update public.outlet_settings set min_hours_to_rank = (p->>'min_hours_to_rank')::numeric, updated_by = public.current_staff_id()
   where outlet_id is not distinct from public.kq_scope(p->>'outlet_id') returning * into r;
  return to_jsonb(r);
end $$;

-- Tablet set-up (managers of that outlet / owner): returns the outlet's tablet code, creating it the first time.
create function public.api_tablet_code(p jsonb) returns jsonb language plpgsql set search_path = public as $$
declare o smallint := (p->>'outlet_id')::smallint; r public.outlet_tablets;
begin
  if not public.manages_outlet(o) then perform public.kq_deny('Only a manager of this outlet (or the owner) can set up its tablet'); end if;
  if coalesce((p->>'new_code')::boolean, false) then delete from public.outlet_tablets where outlet_id = o; end if;
  insert into public.outlet_tablets (outlet_id, created_by) values (o, public.current_staff_id()) on conflict (outlet_id) do nothing;
  select * into r from public.outlet_tablets where outlet_id = o;
  return jsonb_build_object('outlet_id', o, 'outlet', (select name from public.outlets where id = o), 'code', r.code);
end $$;

-- ---------------------------------------------------------------- jobs, staff, assignments
create function public.kq_job_fields(p jsonb) returns jsonb language sql immutable as $$
  select coalesce(jsonb_object_agg(k, case when v = '""'::jsonb then 'null'::jsonb else v end), '{}') from jsonb_each(p) e(k, v)
   where k = any (array['title', 'description', 'kind', 'section_id', 'shift', 'due_time', 'points', 'is_grim', 'recurrence', 'recur_weekday',
                        'verification', 'daily_cap', 'default_assignee_id', 'active']) $$;

create function public.api_jobs(p jsonb) returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.kind, x.title), '[]') from (select j.*, s.name as section from public.jobs j
    left join public.sections s on s.id = j.section_id where j.outlet_id = (p->>'outlet')::smallint) x $$;

create function public.api_create_job(p jsonb) returns jsonb language plpgsql set search_path = public as $$
declare f jsonb; cols text; r public.jobs;
begin
  if not public.is_manager() then perform public.kq_deny('Managers only'); end if;
  f := public.kq_job_fields(p) || jsonb_build_object('outlet_id', p->'outlet_id', 'created_by', public.current_staff_id());
  select string_agg(quote_ident(k), ', ') into cols from jsonb_object_keys(f) k;
  execute format('insert into public.jobs (%s) select %s from jsonb_populate_record(null::public.jobs, $1) returning *', cols, cols) into r using f;
  return to_jsonb(r);
end $$;

create function public.api_update_job(p jsonb) returns jsonb language plpgsql set search_path = public as $$
declare f jsonb := public.kq_job_fields(p); cols text; r public.jobs;
begin
  if not public.is_manager() then perform public.kq_deny('Managers only'); end if;
  if f = '{}'::jsonb then perform public.kq_bad('Nothing to update'); end if;
  select string_agg(quote_ident(k), ', ') into cols from jsonb_object_keys(f) k;
  execute format('update public.jobs set (%s) = (select %s from jsonb_populate_record(null::public.jobs, $1)) where id = $2 returning *', cols, cols)
    into r using f, (p->>'id')::uuid;
  if r.id is null then perform public.kq_deny('Not allowed for your role (or job not found)'); end if;
  return to_jsonb(r);
end $$;

create function public.api_delete_job(p jsonb) returns jsonb language plpgsql set search_path = public as $$
begin
  if not public.is_manager() then perform public.kq_deny('Managers only'); end if;
  delete from public.jobs where id = (p->>'id')::uuid;
  if not found then perform public.kq_deny('Not allowed for your role (or job not found)'); end if;
  return jsonb_build_object('ok', true);
end $$;

create function public.api_staff(p jsonb) returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.role desc, x.name), '[]') from (select s.id, s.name, s.staff_code, s.role, so.is_lead, sec.name as section, so.is_home
    from public.staff s join public.staff_outlets so on so.staff_id = s.id and so.outlet_id = (p->>'outlet')::smallint
    left join public.sections sec on sec.id = s.section_id where s.active) x $$;

create function public.api_create_assignment(p jsonb) returns jsonb language plpgsql set search_path = public as $$
declare r public.assignments;
begin
  if not public.is_manager() then perform public.kq_deny('Managers only'); end if;
  insert into public.assignments (job_id, staff_id, due_date, shift, assigned_by)
  values ((p->>'job_id')::uuid, (p->>'staff_id')::uuid, coalesce(nullif(p->>'due_date', '')::date, public.perth_today()),
          nullif(p->>'shift', '')::public.shift_slot, public.current_staff_id()) returning * into r;
  return to_jsonb(r);
end $$;

create function public.api_assignments(p jsonb) returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.staff_name), '[]') from (select a.*, j.title, j.points, s.name as staff_name, c.status
    from public.assignments a join public.jobs j on j.id = a.job_id join public.staff s on s.id = a.staff_id
    left join public.completions c on c.assignment_id = a.id
   where j.outlet_id = (p->>'outlet')::smallint and a.due_date = coalesce(nullif(p->>'date', '')::date, public.perth_today())) x $$;

-- ---------------------------------------------------------------- tick-offs and sign-off
create function public.api_my_jobs(p jsonb default '{}') returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.shift nulls last, x.title), '[]') from (select a.id as assignment_id, a.due_date, a.shift, j.title, j.description,
     j.points, j.verification, j.is_grim, o.name as outlet, c.id as completion_id, c.status, c.review_note
    from public.assignments a join public.jobs j on j.id = a.job_id join public.outlets o on o.id = j.outlet_id
    left join public.completions c on c.assignment_id = a.id
   where a.staff_id = public.current_staff_id() and a.due_date = public.perth_today()) x $$;

-- Idempotent: the tablet sends its own UUID, so offline retries never double-count.
create function public.api_tick(p jsonb) returns jsonb language plpgsql set search_path = public as $$
declare r public.completions;
begin
  insert into public.completions (id, assignment_id, staff_id, note)
  values (coalesce(nullif(p->>'id', '')::uuid, gen_random_uuid()), (p->>'assignment_id')::uuid, public.current_staff_id(), nullif(p->>'note', ''))
  on conflict (id) do nothing returning * into r;
  return coalesce(to_jsonb(r), jsonb_build_object('id', p->>'id', 'duplicate', true));
end $$;

create function public.api_approvals(p jsonb default '{}') returns jsonb language plpgsql set search_path = public as $$
begin
  if not public.is_reviewer() then perform public.kq_deny('Only shift leads and managers can sign off ticks'); end if;
  return kq_private.kq_rows($q$select c.*, j.title, j.points, j.verification, j.is_grim, public.perth_week_start(c.completed_at) as week_of,
     public.week_locked(j.outlet_id, public.perth_week_start(c.completed_at)) as week_locked, public.perth_week_start() as open_week,
     s.name as staff_name, o.name as outlet, a.due_date, a.shift
     from public.completions c join public.assignments a on a.id = c.assignment_id join public.jobs j on j.id = a.job_id
     join public.staff s on s.id = c.staff_id join public.outlets o on o.id = j.outlet_id
    where c.status = 'pending' and ($1::smallint is null or j.outlet_id = $1::smallint) and public.reviews_outlet(j.outlet_id)
      and c.staff_id is distinct from public.current_staff_id()   -- your own ticks go to another lead, a manager or Ivan
    order by public.week_locked(j.outlet_id, public.perth_week_start(c.completed_at)) desc, c.completed_at$q$, public.kq_scope(p->>'outlet')::text);
end $$;

create function public.api_review(p jsonb) returns jsonb language plpgsql set search_path = public as $$
declare r public.completions;
begin
  if not public.is_reviewer() then perform public.kq_deny('Only shift leads and managers can sign off ticks'); end if;
  if coalesce(p->>'status', '') not in ('approved', 'rejected') then perform public.kq_bad('status must be approved or rejected'); end if;
  update public.completions set status = (p->>'status')::public.completion_status, review_note = nullif(p->>'review_note', '')
   where id = (p->>'id')::uuid returning * into r;
  if r.id is null then perform public.kq_deny('Not allowed for your role (or not found)'); end if;
  return to_jsonb(r);
end $$;

-- Recently approved (last 14 days) that a lead/manager can reverse if the job turns out not to have been done
create function public.api_approved(p jsonb default '{}') returns jsonb language plpgsql set search_path = public as $$
begin
  if not public.is_reviewer() then perform public.kq_deny('Only shift leads and managers can sign off ticks'); end if;
  return kq_private.kq_rows($q$select c.id, c.completed_at, c.reviewed_at, j.title, j.points, s.name as staff_name, o.name as outlet, r.name as approved_by
     from public.completions c join public.assignments a on a.id = c.assignment_id join public.jobs j on j.id = a.job_id
     join public.staff s on s.id = c.staff_id join public.outlets o on o.id = j.outlet_id left join public.staff r on r.id = c.reviewed_by
    where c.status = 'approved' and c.reviewed_at > now() - interval '14 days' and ($1::smallint is null or j.outlet_id = $1::smallint)
      and public.reviews_outlet(j.outlet_id) and c.staff_id is distinct from public.current_staff_id()
    order by c.reviewed_at desc limit 30$q$, public.kq_scope(p->>'outlet')::text);
end $$;

create function public.api_reverse(p jsonb) returns jsonb language plpgsql set search_path = public as $$
begin
  if not public.is_reviewer() then perform public.kq_deny('Only shift leads and managers can sign off ticks'); end if;
  return jsonb_build_object('ledger_id', public.reverse_completion((p->>'id')::uuid, coalesce(p->>'reason', '')));
end $$;

create function public.api_my_points(p jsonb default '{}') returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.awarded_at desc), '[]') from (select l.*, o.name as outlet from public.points_ledger l
    join public.outlets o on o.id = l.outlet_id where l.staff_id = public.current_staff_id() order by l.awarded_at desc limit 50) x $$;

create function public.api_reverse_ledger(p jsonb) returns jsonb language plpgsql set search_path = public as $$
begin
  if not public.is_manager() then perform public.kq_deny('Managers only'); end if;
  return jsonb_build_object('id', public.reverse_points((p->>'id')::bigint, coalesce(nullif(p->>'reason', ''), 'manager decision')));
end $$;

create function public.api_bonus(p jsonb) returns jsonb language plpgsql set search_path = public as $$
declare r public.points_ledger;
begin
  if not public.is_manager() then perform public.kq_deny('Managers only'); end if;
  insert into public.points_ledger (staff_id, outlet_id, entry_type, points, reason, awarded_by)
  values ((p->>'staff_id')::uuid, (p->>'outlet_id')::smallint, 'bonus', (p->>'points')::int, p->>'reason', public.current_staff_id()) returning * into r;
  return to_jsonb(r);
end $$;

-- ---------------------------------------------------------------- weekly reward, hours
create function public.api_rewards(p jsonb) returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.outlet_id nulls first), '[]') from (select r.*, coalesce(o.name, 'Group-wide board') as scope_name
    from public.weekly_rewards r left join public.outlets o on o.id = r.outlet_id where r.week_start = (p->>'week')::date) x $$;

create function public.api_save_reward(p jsonb) returns jsonb language plpgsql set search_path = public as $$
declare r public.weekly_rewards;
begin
  if not public.is_manager() then perform public.kq_deny('Managers only'); end if;
  insert into public.weekly_rewards (outlet_id, week_start, title, details, set_by)
  values (public.kq_scope(p->>'outlet_id'), (p->>'week_start')::date, p->>'title', nullif(p->>'details', ''), public.current_staff_id())
  on conflict (outlet_id, week_start) do update set title = excluded.title, details = excluded.details, set_by = excluded.set_by returning * into r;
  return to_jsonb(r);
end $$;

create function public.api_hours(p jsonb) returns jsonb language plpgsql set search_path = public as $$
declare w date := (p->>'week')::date; allo boolean := p->>'outlet' = 'all'; o smallint := case when p->>'outlet' = 'all' then null else public.kq_scope(p->>'outlet') end;
  locks smallint[]; grp boolean;
begin
  select coalesce(array_agg(outlet_id) filter (where outlet_id is not null), '{}'), bool_or(outlet_id is null) into locks, grp
    from public.weekly_crowns where week_start = w and status = 'confirmed';
  return jsonb_build_object(
    'rows', (select coalesce(jsonb_agg(to_jsonb(x) order by x.outlet_id, x.name), '[]') from (
       select so.outlet_id, ou.name as outlet, s.id as staff_id, s.name, s.staff_code, sec.name as section,
              h.hours, h.leave_status, h.source, h.updated_at, prev.hours as last_week_hours, prev.leave_status as last_week_leave
         from public.staff_outlets so join public.staff s on s.id = so.staff_id and s.role <> 'owner' and s.active
         join public.outlets ou on ou.id = so.outlet_id left join public.sections sec on sec.id = s.section_id
         left join public.weekly_hours h on h.staff_id = s.id and h.outlet_id = so.outlet_id and h.week_start = w
         left join public.weekly_hours prev on prev.staff_id = s.id and prev.outlet_id = so.outlet_id and prev.week_start = w - 7
        where allo or so.outlet_id = o) x),
    'locked_outlets', to_jsonb(locks), 'group_locked', coalesce(grp, false),
    'entry_open', public.hours_entry_open(w), 'opens_at', public.hours_entry_opens_at(w));
end $$;

create function public.api_save_hours(p jsonb) returns jsonb language plpgsql set search_path = public as $$
declare x jsonb; n int := 0;
begin
  if not public.is_owner() then perform public.kq_deny('Only the owner can do this'); end if;
  if jsonb_typeof(p->'rows') is distinct from 'array' then perform public.kq_bad('rows required'); end if;
  for x in select * from jsonb_array_elements(p->'rows') loop
    insert into public.weekly_hours (staff_id, outlet_id, week_start, hours, leave_status, source, entered_by)
    values ((x->>'staff_id')::uuid, (x->>'outlet_id')::smallint, (p->>'week_start')::date, coalesce(nullif(x->>'hours', '')::numeric, 0),
            coalesce(nullif(x->>'leave_status', ''), 'none')::public.leave_status, coalesce(nullif(x->>'source', ''), 'manual')::public.hours_source,
            public.current_staff_id())
    on conflict (staff_id, outlet_id, week_start) do update
      set hours = excluded.hours, leave_status = excluded.leave_status, source = excluded.source, entered_by = excluded.entered_by
      where (public.weekly_hours.hours, public.weekly_hours.leave_status) is distinct from (excluded.hours, excluded.leave_status);
    n := n + 1;
  end loop;
  return jsonb_build_object('saved', n);
end $$;

-- ---------------------------------------------------------------- messages, handovers, audit
create function public.api_channels(p jsonb default '{}') returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.kind, x.outlet_id nulls first), '[]') from (select ch.*, o.name as outlet,
     (select count(*) from public.messages m where m.channel_id = ch.id)::int as message_count,
     (select string_agg(s.name, ', ') from public.channel_members cm join public.staff s on s.id = cm.staff_id where cm.channel_id = ch.id) as members
    from public.channels ch left join public.outlets o on o.id = ch.outlet_id) x $$;

create function public.api_messages(p jsonb) returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.pinned desc, x.created_at), '[]') from (select m.*, s.name as sender, s.role as sender_role,
     (select count(*) from public.message_reads r where r.message_id = m.id)::int as read_count,
     (select count(*) from public.staff_outlets so join public.channels ch on ch.id = m.channel_id
       where ch.is_everyone and (ch.outlet_id is null or so.outlet_id = ch.outlet_id))::int as audience
    from public.messages m join public.staff s on s.id = m.sender_id where m.channel_id = (p->>'channel')::uuid) x $$;

create function public.api_post_message(p jsonb) returns jsonb language plpgsql set search_path = public as $$
declare r public.messages;
begin
  if (coalesce((p->>'is_memo')::boolean, false) or coalesce((p->>'pinned')::boolean, false)) and not public.is_manager() then
    perform public.kq_deny('Only managers can post memos'); end if;
  insert into public.messages (channel_id, sender_id, body, is_memo, pinned)
  values ((p->>'channel_id')::uuid, public.current_staff_id(), p->>'body', coalesce((p->>'is_memo')::boolean, false), coalesce((p->>'pinned')::boolean, false))
  returning * into r;
  return to_jsonb(r);
end $$;

create function public.api_pin_message(p jsonb) returns jsonb language plpgsql set search_path = public as $$
declare r public.messages;
begin
  if not public.is_manager() then perform public.kq_deny('Managers only'); end if;
  update public.messages set pinned = coalesce((p->>'pinned')::boolean, false) where id = (p->>'id')::uuid returning * into r;
  return to_jsonb(r);
end $$;

create function public.api_read_message(p jsonb) returns jsonb language plpgsql set search_path = public as $$
begin
  insert into public.message_reads (message_id, staff_id) values ((p->>'id')::uuid, public.current_staff_id()) on conflict do nothing;
  return jsonb_build_object('ok', true);
end $$;

create function public.api_handovers(p jsonb default '{}') returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by (x.confirmed_at is null) desc, x.shift_date desc, x.created_at desc), '[]') from (
    select h.*, w.name as written_by_name, cb.name as confirmed_by_name, o.name as outlet
      from public.handovers h join public.staff w on w.id = h.written_by left join public.staff cb on cb.id = h.confirmed_by
      join public.outlets o on o.id = h.outlet_id where (public.kq_scope(p->>'outlet') is null or h.outlet_id = public.kq_scope(p->>'outlet'))
     order by (h.confirmed_at is null) desc, h.shift_date desc, h.created_at desc limit 30) x $$;

create function public.api_write_handover(p jsonb) returns jsonb language plpgsql set search_path = public as $$
declare r public.handovers;
begin
  insert into public.handovers (outlet_id, shift_date, shift, written_by, prep_notes, equipment_faults, customer_issues, deliveries, staffing, is_weekend_gap)
  values ((p->>'outlet_id')::smallint, coalesce(nullif(p->>'shift_date', '')::date, public.perth_today()), (p->>'shift')::public.shift_slot,
          public.current_staff_id(), p->>'prep_notes', p->>'equipment_faults', p->>'customer_issues', p->>'deliveries', p->>'staffing',
          coalesce((p->>'is_weekend_gap')::boolean, false)) returning * into r;
  return to_jsonb(r);
end $$;

create function public.api_confirm_handover(p jsonb) returns jsonb language plpgsql set search_path = public as $$
declare r public.handovers;
begin
  update public.handovers set confirmed_by = public.current_staff_id() where id = (p->>'id')::uuid returning * into r;
  if r.id is null then perform public.kq_deny('Only shift leads or managers at this outlet can confirm'); end if;
  return to_jsonb(r);
end $$;

create function public.api_audit(p jsonb default '{}') returns jsonb language plpgsql set search_path = public as $$
begin
  if not public.is_owner() then perform public.kq_deny('Only the owner can do this'); end if;   -- RLS also limits audit_log to the owner
  return kq_private.kq_rows($q$select a.*, s.name as actor from public.audit_log a left join public.staff s on s.id = a.actor_id
    where ($1 is null or a.table_name = $1) order by a.id desc limit 100$q$, nullif(p->>'table', ''));
end $$;

-- Only signed-in users call the API; anon gets the tablet roster (above) and nothing else.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'api\_%' loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;
revoke all on function kq_private.kq_rows(text, text) from public, anon;
grant execute on function kq_private.kq_rows(text, text) to authenticated;
