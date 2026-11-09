-- Strict roles, enforced in the database (RLS + guard triggers + RPC checks), not just the UI.
--   Owner (Ivan):     everything, every outlet, and the ONLY role that can confirm or override weekly winners
--                     (each outlet's board and the group-wide board). The ONLY role that enters/edits weekly hours
--                     and the minimum-hours setting, and sets seasons (10-12 weeks). Sets the group-wide weekly reward.
--   Outlet manager:   for the outlet(s) they belong to: jobs and point values, assignments, staff (role 'staff' only),
--                     roster, completion sign-off, points bonus/reversal, that outlet's weekly reward text, memos.
--                     Read-only view of their outlet's weekly hours. Cannot confirm/override winners or edit hours.
--   Staff:            view their own jobs, tick them off (pending until a manager approves), chat, read memos.
--   Shift lead (staff_outlets.is_lead, per outlet): at that outlet, approve/reject/reverse OTHER people's ticks and
--                     write/confirm handovers. Cannot add or edit jobs, assignments, staff, bonuses or rewards.
--   Everyone:         nobody approves, rejects or reverses their own tick; the approver never earns points for it.

create function public.current_staff_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.staff where auth_user_id = auth.uid() and active $$;

create function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff where auth_user_id = auth.uid() and role = 'owner' and active) $$;

-- manager anywhere (or owner)
create function public.is_manager() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff where auth_user_id = auth.uid() and role in ('manager', 'owner') and active) $$;

create function public.in_outlet(p_outlet smallint) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_owner() or exists (select 1 from public.staff_outlets so
           where so.outlet_id = p_outlet and so.staff_id = public.current_staff_id()) $$;

create function public.manages_outlet(p_outlet smallint) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_owner() or exists (select 1 from public.staff s join public.staff_outlets so on so.staff_id = s.id
           where s.auth_user_id = auth.uid() and s.active and s.role = 'manager' and so.outlet_id = p_outlet) $$;

-- can sign off ticks at this outlet: the owner, a manager of it, or a shift lead at it (never their own tick: see guard)
create function public.reviews_outlet(p_outlet smallint) returns boolean
language sql stable security definer set search_path = public as $$
  select public.manages_outlet(p_outlet) or exists (select 1 from public.staff s join public.staff_outlets so on so.staff_id = s.id
           where s.auth_user_id = auth.uid() and s.active and so.is_lead and so.outlet_id = p_outlet) $$;

create function public.leads_outlet(p_outlet smallint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff_outlets so where so.staff_id = public.current_staff_id() and so.is_lead and so.outlet_id = p_outlet) $$;

-- does the current user manage any outlet this staff member works at?
create function public.manages_staff(p_staff uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_owner() or exists (select 1 from public.staff_outlets so
           where so.staff_id = p_staff and public.manages_outlet(so.outlet_id)) $$;

create function public.job_outlet(p_job uuid) returns smallint
language sql stable security definer set search_path = public as $$ select outlet_id from public.jobs where id = p_job $$;

create function public.assignment_outlet(p_assignment uuid) returns smallint
language sql stable security definer set search_path = public as $$
  select j.outlet_id from public.assignments a join public.jobs j on j.id = a.job_id where a.id = p_assignment $$;

create function public.staff_role_of(p_staff uuid) returns public.staff_role
language sql stable security definer set search_path = public as $$ select role from public.staff where id = p_staff $$;

create function public.can_see_channel(p_channel uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.channels c where c.id = p_channel
                   and ((c.is_everyone and (c.outlet_id is null or public.in_outlet(c.outlet_id)))
                        or exists (select 1 from public.channel_members m
                                    where m.channel_id = c.id and m.staff_id = public.current_staff_id()))) $$;

-- Guard: staff create only a pending tick-off on their own assignment and edit the note while pending.
-- Sign-off by a manager or shift lead of that job's outlet (or the owner), never on their own tick. Daily caps on repeatable jobs.
create function public.guard_completion() returns trigger
language plpgsql set search_path = public as $$
declare v_cap int; v_done int; v_job uuid; v_date date; v_outlet smallint;
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;  -- service role / seed
  select j.daily_cap, j.id, a.due_date, j.outlet_id into v_cap, v_job, v_date, v_outlet
    from public.assignments a join public.jobs j on j.id = a.job_id where a.id = new.assignment_id;
  if tg_op = 'INSERT' and v_cap is not null then
    select count(*) into v_done from public.completions c join public.assignments a on a.id = c.assignment_id
     where a.job_id = v_job and a.due_date = v_date and c.staff_id = new.staff_id;
    if v_done >= v_cap then raise exception 'Daily limit reached for this job' using errcode = '42501'; end if;
  end if;
  if public.reviews_outlet(v_outlet) then
    -- leads may only sign off (status + note); creating ticks for others or editing other columns is manager-only
    if not public.manages_outlet(v_outlet) and new.staff_id is distinct from public.current_staff_id()
       and (tg_op = 'INSERT' or new.staff_id is distinct from old.staff_id or new.assignment_id is distinct from old.assignment_id
            or new.note is distinct from old.note or new.completed_at is distinct from old.completed_at) then
      raise exception 'Shift leads can only approve, reject or reverse ticks' using errcode = '42501';
    end if;
    if (tg_op = 'INSERT' and new.status <> 'pending') or (tg_op = 'UPDATE' and new.status is distinct from old.status) then
      if new.staff_id = public.current_staff_id() then
        raise exception 'You cannot approve, reject or reverse your own tick' using errcode = '42501';
      end if;
      -- Allowed: pending -> approved | rejected; approved -> reversed (needs a reason). Nothing else.
      if tg_op = 'UPDATE' and not ((old.status = 'pending' and new.status in ('approved', 'rejected'))
                                 or (old.status = 'approved' and new.status = 'reversed')) then
        raise exception 'Cannot change a % job to %', old.status, new.status using errcode = '42501';
      end if;
      new.reviewed_by := public.current_staff_id();
      new.reviewed_at := now();
    end if;
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.reviewed_by is not null or new.reviewed_at is not null then
      raise exception 'Only managers can sign off jobs' using errcode = '42501';
    end if;
  elsif new.status is distinct from old.status or new.reviewed_by is distinct from old.reviewed_by
     or new.reviewed_at is distinct from old.reviewed_at or new.review_note is distinct from old.review_note
     or new.staff_id is distinct from old.staff_id or new.assignment_id is distinct from old.assignment_id then
    raise exception 'Only managers can sign off jobs' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger completions_guard before insert or update on public.completions
for each row execute function public.guard_completion();

-- Guard: memos and pinning are manager-only; people edit only their own messages
create function public.guard_message() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  if not public.is_manager() then
    if new.is_memo or new.pinned then
      raise exception 'Only managers can post memos or pin messages' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and old.sender_id <> public.current_staff_id() then
      raise exception 'You can only edit your own messages' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger messages_guard before insert or update on public.messages
for each row execute function public.guard_message();

-- Guard: a handover is locked once confirmed; confirmed by someone other than the writer (table check)
create function public.guard_handover() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  if old.confirmed_at is not null then
    raise exception 'This handover is already confirmed and locked' using errcode = '42501';
  end if;
  if new.confirmed_by is distinct from old.confirmed_by then
    if new.confirmed_by <> public.current_staff_id() then
      raise exception 'You can only confirm as yourself' using errcode = '42501';
    end if;
    new.confirmed_at := now();
  elsif old.written_by <> public.current_staff_id() and not public.manages_outlet(old.outlet_id) then
    raise exception 'Only the writer can edit an open handover' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger handovers_guard before update on public.handovers
for each row execute function public.guard_handover();

-- Guard: crowns can only be changed by the owner (defence in depth beside the RLS policy)
create function public.guard_crown() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') and not public.is_owner() then
    raise exception 'Only the owner can approve or override weekly winners' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger crowns_guard before insert or update or delete on public.weekly_crowns
for each row execute function public.guard_crown();

-- Hours guard: owner-only writes (defence in depth beside RLS), and the lock: once the owner has signed off a week's winner for an outlet (or the group board), that week's
-- weekly_hours rows for the outlet are read-only for everyone (no role is exempt).
create function public.guard_hours_lock() returns trigger
language plpgsql set search_path = public as $$
declare r record;
begin
  r := coalesce(new, old);
  if current_user in ('authenticated', 'anon') and not public.is_owner() then
    raise exception 'Only the owner can enter or edit weekly hours' using errcode = '42501';
  end if;
  if public.week_locked(r.outlet_id, r.week_start)
     or (tg_op = 'UPDATE' and public.week_locked(old.outlet_id, old.week_start)) then
    raise exception 'Hours for this week are locked: the owner has signed off the winner' using errcode = '42501';
  end if;
  if tg_op <> 'DELETE' and current_user in ('authenticated', 'anon') and not public.hours_entry_open(new.week_start) then
    raise exception 'Hours for the week of % open on Sunday 18:00 AWST', to_char(new.week_start, 'FMDD Mon') using errcode = '42501';
  end if;
  return r;
end $$;
create trigger weekly_hours_lock before insert or update or delete on public.weekly_hours
for each row execute function public.guard_hours_lock();

-- Enable RLS on every table
do $$ declare t text; begin
  foreach t in array array['outlets','sections','staff','staff_outlets','roster_shifts','jobs','assignments','completions',
                           'points_ledger','seasons','weekly_hours','outlet_settings','weekly_rewards','weekly_crowns','badges','staff_badges','handovers','channels',
                           'channel_members','messages','message_reads','audit_log'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- Group-wide reference data: everyone reads, owner writes
create policy outlets_read    on public.outlets  for select to authenticated using (true);
create policy outlets_manage  on public.outlets  for all to authenticated using (public.is_owner()) with check (public.is_owner());
create policy sections_read   on public.sections for select to authenticated using (true);
create policy sections_manage on public.sections for all to authenticated using (public.is_owner()) with check (public.is_owner());
create policy badges_read     on public.badges   for select to authenticated using (true);
create policy badges_manage   on public.badges   for all to authenticated using (public.is_owner()) with check (public.is_owner());
create policy staff_badges_read   on public.staff_badges for select to authenticated using (true);
create policy staff_badges_manage on public.staff_badges for all to authenticated
  using (public.manages_staff(staff_id)) with check (public.manages_staff(staff_id));

-- staff: names visible to everyone (group board); managers edit role-'staff' people at their outlets; owner anyone
create policy staff_read   on public.staff for select to authenticated using (true);
create policy staff_insert on public.staff for insert to authenticated
  with check (public.is_owner() or (public.is_manager() and role = 'staff'));
create policy staff_update on public.staff for update to authenticated
  using (public.is_owner() or (role = 'staff' and public.manages_staff(id)))
  with check (public.is_owner() or (role = 'staff' and public.manages_staff(id)));
create policy staff_delete on public.staff for delete to authenticated
  using (public.is_owner() or (role = 'staff' and public.manages_staff(id)));

create policy staff_outlets_read   on public.staff_outlets for select to authenticated using (true);
create policy staff_outlets_manage on public.staff_outlets for all to authenticated
  using (public.is_owner() or (public.manages_outlet(outlet_id) and public.staff_role_of(staff_id) = 'staff'))
  with check (public.is_owner() or (public.manages_outlet(outlet_id) and public.staff_role_of(staff_id) = 'staff'));

create policy roster_read   on public.roster_shifts for select to authenticated using (public.in_outlet(outlet_id));
create policy roster_manage on public.roster_shifts for all to authenticated
  using (public.manages_outlet(outlet_id)) with check (public.manages_outlet(outlet_id));

-- jobs: people at the outlet read active jobs; only that outlet's managers (or owner) write
create policy jobs_read   on public.jobs for select to authenticated
  using (public.in_outlet(outlet_id) and (active or public.manages_outlet(outlet_id)));
create policy jobs_insert on public.jobs for insert to authenticated with check (public.manages_outlet(outlet_id));
create policy jobs_update on public.jobs for update to authenticated
  using (public.manages_outlet(outlet_id)) with check (public.manages_outlet(outlet_id));
create policy jobs_delete on public.jobs for delete to authenticated using (public.manages_outlet(outlet_id));

-- assignments: staff see their own; managers of the job's outlet assign, only to people who work there
create policy assignments_read on public.assignments for select to authenticated
  using (staff_id = public.current_staff_id() or public.reviews_outlet(public.job_outlet(job_id)));   -- leads read (to sign off), only managers write
create policy assignments_insert on public.assignments for insert to authenticated
  with check (public.manages_outlet(public.job_outlet(job_id))
              and exists (select 1 from public.staff_outlets so where so.staff_id = assignments.staff_id
                           and so.outlet_id = public.job_outlet(job_id)));
create policy assignments_update on public.assignments for update to authenticated
  using (public.manages_outlet(public.job_outlet(job_id))) with check (public.manages_outlet(public.job_outlet(job_id)));
create policy assignments_delete on public.assignments for delete to authenticated
  using (public.manages_outlet(public.job_outlet(job_id)));

-- completions
create policy completions_read on public.completions for select to authenticated
  using (staff_id = public.current_staff_id() or public.reviews_outlet(public.assignment_outlet(assignment_id)));
create policy completions_insert on public.completions for insert to authenticated
  with check (public.manages_outlet(public.assignment_outlet(assignment_id))
              or (staff_id = public.current_staff_id() and status = 'pending'
                  and exists (select 1 from public.assignments a
                               where a.id = assignment_id and a.staff_id = public.current_staff_id())));
create policy completions_update on public.completions for update to authenticated
  using ((public.reviews_outlet(public.assignment_outlet(assignment_id)) and staff_id <> public.current_staff_id())
         or public.manages_outlet(public.assignment_outlet(assignment_id)) or (staff_id = public.current_staff_id() and status = 'pending'))
  with check ((public.reviews_outlet(public.assignment_outlet(assignment_id)) and staff_id <> public.current_staff_id())
         or public.manages_outlet(public.assignment_outlet(assignment_id)) or (staff_id = public.current_staff_id() and status = 'pending'));
create policy completions_delete on public.completions for delete to authenticated
  using (public.manages_outlet(public.assignment_outlet(assignment_id)) or (staff_id = public.current_staff_id() and status = 'pending'));

-- points ledger: everyone reads (boards, "why did I get this point"); outlet managers add bonus/reversal rows only
create policy ledger_read   on public.points_ledger for select to authenticated using (true);
create policy ledger_insert on public.points_ledger for insert to authenticated
  with check (public.manages_outlet(outlet_id) and entry_type in ('bonus', 'reversal') and staff_id <> public.current_staff_id());

-- weekly hours: ONLY the owner enters/edits (all outlets). Outlet managers read their outlet's hours; staff read their own.
create policy weekly_hours_read  on public.weekly_hours for select to authenticated
  using (staff_id = public.current_staff_id() or public.manages_outlet(outlet_id));
create policy weekly_hours_owner on public.weekly_hours for all to authenticated
  using (public.is_owner())
  with check (public.is_owner()
              and exists (select 1 from public.staff_outlets so where so.staff_id = weekly_hours.staff_id and so.outlet_id = weekly_hours.outlet_id));

-- seasons: everyone reads; ONLY the owner creates or changes them (length 10..12 weeks enforced by CHECK)
create policy seasons_read  on public.seasons for select to authenticated using (true);
create policy seasons_owner on public.seasons for all to authenticated using (public.is_owner()) with check (public.is_owner());

-- ranking settings (minimum hours): everyone reads; ONLY the owner changes them (they decide who can be crowned)
create policy outlet_settings_read  on public.outlet_settings for select to authenticated using (true);
create policy outlet_settings_owner on public.outlet_settings for all to authenticated
  using (public.is_owner()) with check (public.is_owner());

-- weekly reward text: outlet managers for their outlet; owner for any outlet and the group-wide board (outlet_id null)
create policy weekly_rewards_read   on public.weekly_rewards for select to authenticated using (true);
create policy weekly_rewards_manage on public.weekly_rewards for all to authenticated
  using (case when outlet_id is null then public.is_owner() else public.manages_outlet(outlet_id) end)
  with check (case when outlet_id is null then public.is_owner() else public.manages_outlet(outlet_id) end);

-- weekly crowns: everyone reads; ONLY the owner can approve/override (no insert/delete policies at all)
create policy weekly_crowns_read  on public.weekly_crowns for select to authenticated using (true);
create policy weekly_crowns_owner on public.weekly_crowns for update to authenticated
  using (public.is_owner()) with check (public.is_owner());

-- handovers
create policy handovers_read   on public.handovers for select to authenticated using (public.in_outlet(outlet_id));
create policy handovers_insert on public.handovers for insert to authenticated
  with check (written_by = public.current_staff_id() and public.in_outlet(outlet_id)
              and (public.manages_outlet(outlet_id) or public.leads_outlet(outlet_id)));
create policy handovers_update on public.handovers for update to authenticated
  using (public.in_outlet(outlet_id) and (public.manages_outlet(outlet_id) or public.leads_outlet(outlet_id)));

-- channels, members, messages, read receipts
create policy channels_read   on public.channels for select to authenticated using (public.can_see_channel(id));
create policy channels_insert on public.channels for insert to authenticated
  with check (case when kind = 'direct' then created_by = public.current_staff_id()
                   when outlet_id is null then public.is_owner() else public.manages_outlet(outlet_id) end);
create policy channels_update on public.channels for update to authenticated
  using (case when outlet_id is null then public.is_owner() else public.manages_outlet(outlet_id) end);
create policy channels_delete on public.channels for delete to authenticated
  using (case when outlet_id is null then public.is_owner() else public.manages_outlet(outlet_id) end);

create policy members_read   on public.channel_members for select to authenticated using (public.can_see_channel(channel_id));
create policy members_insert on public.channel_members for insert to authenticated
  with check (exists (select 1 from public.channels c where c.id = channel_id
              and (c.created_by = public.current_staff_id()
                   or (c.outlet_id is not null and public.manages_outlet(c.outlet_id)) or public.is_owner())));
create policy members_delete on public.channel_members for delete to authenticated
  using (exists (select 1 from public.channels c where c.id = channel_id
              and ((c.outlet_id is not null and public.manages_outlet(c.outlet_id)) or public.is_owner())));

create policy messages_read   on public.messages for select to authenticated using (public.can_see_channel(channel_id));
create policy messages_insert on public.messages for insert to authenticated
  with check (sender_id = public.current_staff_id() and public.can_see_channel(channel_id));
create policy messages_update on public.messages for update to authenticated
  using (public.is_manager() or sender_id = public.current_staff_id());
create policy messages_delete on public.messages for delete to authenticated
  using (public.is_manager() or sender_id = public.current_staff_id());

create policy reads_read   on public.message_reads for select to authenticated
  using (public.is_manager() or staff_id = public.current_staff_id());
create policy reads_insert on public.message_reads for insert to authenticated
  with check (staff_id = public.current_staff_id());

-- audit log: owner reads all; managers read entries they or their outlet's staff made (prototype: any manager)
create policy audit_read on public.audit_log for select to authenticated using (public.is_owner());   -- owner only

-- Grants (explicit, so behaviour is identical on Supabase where default grants are broad)
revoke all on all tables in schema public from anon, authenticated;
grant usage on schema public to anon, authenticated;
grant select on public.outlets, public.sections, public.points_ledger, public.audit_log, public.badges,
               public.staff_badges, public.staff_outlets, public.roster_shifts, public.weekly_crowns,
               public.leaderboard_daily, public.leaderboard_weekly, public.leaderboard_sections_weekly,
               public.weekly_board, public.top3_streaks, public.weekly_winners to authenticated;
grant insert on public.points_ledger to authenticated;
grant update on public.weekly_crowns to authenticated;
grant insert, update, delete on public.outlets, public.sections, public.badges, public.staff_badges,
               public.staff_outlets, public.roster_shifts to authenticated;
grant select, insert, update, delete on public.weekly_hours, public.outlet_settings, public.seasons to authenticated;
grant select on public.season_board, public.current_season to authenticated;
grant select, insert, update, delete on public.jobs, public.assignments, public.completions, public.weekly_rewards,
               public.handovers, public.channels, public.channel_members, public.messages to authenticated;
grant select, insert on public.message_reads to authenticated;
grant select (id, name, staff_code, role, section_id, started_on, active, created_at) on public.staff to authenticated;
grant insert (name, staff_code, external_id, role, section_id, started_on, pin_hash, active),
      update (name, staff_code, external_id, role, section_id, started_on, pin_hash, active), delete on public.staff to authenticated;
grant usage on all sequences in schema public to authenticated;

-- RPCs -----------------------------------------------------------------------------------
-- Tap-name + PIN check. On Supabase, call it from an Edge Function that then mints the user's session.
create function public.verify_staff_pin(p_staff_id uuid, p_pin text)
returns table (auth_user_id uuid, staff_id uuid, name text, role public.staff_role, is_lead boolean)
language sql stable security definer set search_path = public, extensions as $$
  select s.auth_user_id, s.id, s.name, s.role, exists (select 1 from public.staff_outlets so where so.staff_id = s.id and so.is_lead) from public.staff s
   where s.id = p_staff_id and s.active and s.pin_hash = extensions.crypt(p_pin, s.pin_hash) $$;
revoke all on function public.verify_staff_pin(uuid, text) from public;
grant execute on function public.verify_staff_pin(uuid, text) to anon, authenticated;

create function public.set_staff_pin(p_staff_id uuid, p_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not (public.is_owner() or (public.staff_role_of(p_staff_id) = 'staff' and public.manages_staff(p_staff_id))) then
    raise exception 'Not allowed to set this PIN' using errcode = '42501';
  end if;
  if p_pin !~ '^[0-9]{4,6}$' then raise exception 'PIN must be 4 to 6 digits'; end if;
  update public.staff set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf')) where id = p_staff_id;
end $$;
revoke all on function public.set_staff_pin(uuid, text) from public;
grant execute on function public.set_staff_pin(uuid, text) to authenticated;

-- Reverse a ledger entry (e.g. failed spot check): adds a new row; nothing is edited
create function public.reverse_points(p_entry_id bigint, p_reason text) returns bigint
language plpgsql set search_path = public as $$
declare v_id bigint;
begin
  insert into public.points_ledger (staff_id, outlet_id, entry_type, points, reason, completion_id, reverses_id, awarded_by)
  select staff_id, outlet_id, 'reversal', -points, 'Reversed: ' || p_reason, completion_id, id, public.current_staff_id()
    from public.points_ledger where id = p_entry_id and entry_type <> 'reversal'
  returning id into v_id;   -- RLS ledger_insert enforces "manager of that outlet"
  if v_id is null then raise exception 'Entry not found or already a reversal'; end if;
  return v_id;
end $$;
grant execute on function public.reverse_points(bigint, text) to authenticated;

-- Reverse an approved job that turns out not to have been done: status approved -> reversed with a reason.
-- The ledger trigger adds the negative entry (credited to the open week if the original week is signed off),
-- and both the status change and the ledger entry are written to the audit log.
create function public.reverse_completion(p_completion uuid, p_reason text) returns bigint
language plpgsql set search_path = public as $$
declare v_id bigint;
begin
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Give a reason for the reversal' using errcode = '22023'; end if;
  update public.completions set status = 'reversed', review_note = p_reason where id = p_completion and status = 'approved';
  if not found then raise exception 'Only approved ticks at your outlet (not your own) can be reversed' using errcode = '42501'; end if;
  select id into v_id from public.points_ledger where completion_id = p_completion and entry_type = 'reversal' order by id desc limit 1;
  return v_id;
end $$;
grant execute on function public.reverse_completion(uuid, text) to authenticated;

-- Create assignments for recurring jobs that have a default assignee (pg_cron daily on Supabase)
create function public.generate_recurring_assignments(p_date date default public.perth_today())
returns integer language plpgsql set search_path = public as $$
declare n int;
begin
  insert into public.assignments (job_id, staff_id, due_date, shift)
  select j.id, j.default_assignee_id, p_date, j.shift from public.jobs j
   where j.active and j.default_assignee_id is not null
     and (current_user not in ('authenticated', 'anon') or public.manages_outlet(j.outlet_id))
     and (j.recurrence in ('daily', 'per_shift')
          or (j.recurrence = 'weekly' and j.recur_weekday = extract(isodow from p_date)))
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
grant execute on function public.generate_recurring_assignments(date) to authenticated;

-- OWNER ONLY: switch an outlet on (go live) or off. Audited via the outlets trigger.
create function public.set_outlet_active(p_outlet smallint, p_active boolean) returns void
language plpgsql set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Only the owner can switch outlets on or off' using errcode = '42501'; end if;
  update public.outlets set is_active = p_active,
         activated_at = case when p_active then coalesce(activated_at, now()) else activated_at end
   where id = p_outlet;
end $$;
grant execute on function public.set_outlet_active(smallint, boolean) to authenticated;

-- OWNER ONLY: approve the pending crown for an outlet (or the group board when p_outlet is null)
create function public.confirm_weekly_crown(p_outlet smallint, p_week_start date) returns void
language plpgsql set search_path = public as $$
begin
  if not public.is_owner() then
    raise exception 'Only the owner can approve or override weekly winners' using errcode = '42501';
  end if;
  perform public.crown_weekly_winners();
  update public.weekly_crowns set status = 'confirmed', confirmed_by = public.current_staff_id(), confirmed_at = now()
   where outlet_id is not distinct from p_outlet and week_start = p_week_start and status = 'pending';
  if not found then raise exception 'No pending crown for that week (weeks end Sunday 23:59:59 AWST)'; end if;
end $$;
grant execute on function public.confirm_weekly_crown(smallint, date) to authenticated;

-- OWNER ONLY: choose a different winner (reason required). Counts as approval. Audited by trigger (who/when/old/new).
create function public.override_weekly_crown(p_outlet smallint, p_week_start date, p_winner uuid, p_reason text) returns void
language plpgsql set search_path = public as $$
begin
  if not public.is_owner() then
    raise exception 'Only the owner can approve or override weekly winners' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Give a reason for the override'; end if;
  perform public.crown_weekly_winners();
  update public.weekly_crowns
     set winner_id = p_winner, overridden = (p_winner is distinct from auto_winner_id),
         override_by = public.current_staff_id(), override_reason = p_reason,
         status = 'confirmed', confirmed_by = public.current_staff_id(), confirmed_at = now()
   where outlet_id is not distinct from p_outlet and week_start = p_week_start;
  if not found then raise exception 'That week has not finished yet (weeks end Sunday 23:59:59 AWST)'; end if;
end $$;
grant execute on function public.override_weekly_crown(smallint, date, uuid, text) to authenticated;
grant execute on function public.crown_weekly_winners() to authenticated;

-- Weekly recap for an outlet (or group): confirmed crown + top 3 + that week's reward, as a pinned memo
create function public.publish_weekly_recap(p_outlet smallint,
  p_week_start date default public.perth_week_start(now() - interval '7 days'))
returns text language plpgsql set search_path = public as $$
declare v_text text; v_channel uuid; v_crown text; v_reward text;
begin
  if not (case when p_outlet is null then public.is_owner() else public.manages_outlet(p_outlet) end) then
    raise exception 'Managers only' using errcode = '42501';
  end if;
  select '👑 ' || s.name || ' is the champion' into v_crown
    from public.weekly_crowns c join public.staff s on s.id = c.winner_id
   where c.outlet_id is not distinct from p_outlet and c.week_start = p_week_start and c.status = 'confirmed';
  if v_crown is null then raise exception 'The owner needs to approve this week''s winner first' using errcode = '42501'; end if;
  select '🎁 Reward: ' || title || coalesce(' (' || details || ')', '') into v_reward
    from public.weekly_rewards where outlet_id is not distinct from p_outlet and week_start = p_week_start;
  select string_agg(case position when 1 then '🥇' when 2 then '🥈' else '🥉' end || ' ' || name ||
                    ' (' || points_per_hour || ' pts/hr, ' || points || ' pts, ' || hours || ' h)', E'\n' order by position)
    into v_text from public.weekly_winners where outlet_id is not distinct from p_outlet and week_start = p_week_start;
  v_text := 'Weekly recap, week of ' || to_char(p_week_start, 'FMDD Mon YYYY') || E'\n' || v_crown || E'\n' ||
            coalesce(v_reward || E'\n', '') || coalesce(v_text, '');
  select id into v_channel from public.channels where is_everyone and outlet_id is not distinct from p_outlet limit 1;
  insert into public.messages (channel_id, sender_id, body, is_memo, pinned)
  values (v_channel, public.current_staff_id(), v_text, true, true);
  return v_text;
end $$;
grant execute on function public.publish_weekly_recap(smallint, date) to authenticated;
