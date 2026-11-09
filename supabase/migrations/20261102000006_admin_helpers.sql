-- Go-live helpers for Ivan, run in the Supabase SQL editor (Dashboard → SQL Editor). They are NOT callable from the
-- app or the internet (no grants to anon/authenticated), so they skip the app's role checks on purpose.
--   select public.admin_add_person('Maya Brooks', 'boughshed-kitchen', 'staff', '4821');            -- staff + 4-digit PIN
--   select public.admin_add_person('Lachlan Harris', 'boughshed-kitchen', 'staff', '7310', true);    -- shift lead
--   select public.admin_add_person('Jack Wiremu', 'boughshed-kitchen', 'manager', p_email => 'jack@yourbusiness.com.au');
--   select public.admin_add_to_outlet('Maya Brooks', 'monkey-bar-kitchen');                          -- works at a second outlet
--   select public.admin_set_pin('Maya Brooks', '5590');                                               -- forgotten PIN
-- Managers also need a login: Authentication → Users → Add user (same email, Auto Confirm). It links on first sign-in.

create function public.kq_outlet_of(p text) returns smallint language plpgsql stable set search_path = public as $$
declare o smallint;
begin
  select id into o from public.outlets where slug = lower(trim(p)) or lower(name) = lower(trim(p));
  if o is null then raise exception 'No outlet called "%". Use one of: %', p, (select string_agg(slug, ', ' order by rollout_order) from public.outlets); end if;
  return o;
end $$;

create function public.kq_person_of(p text) returns uuid language plpgsql stable set search_path = public as $$
declare v uuid; n int;
begin
  select count(*), min(id::text)::uuid into n, v from public.staff where lower(name) = lower(trim(p)) and active;
  if n = 0 then raise exception 'Nobody called "%"', p; end if;
  if n > 1 then raise exception 'More than one person is called "%"; use their id instead', p; end if;
  return v;
end $$;

create function public.admin_add_person(p_name text, p_outlet text, p_role public.staff_role default 'staff', p_pin text default null,
                                        p_lead boolean default false, p_email text default null) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare v uuid; o smallint := public.kq_outlet_of(p_outlet);
begin
  if coalesce(trim(p_name), '') = '' then raise exception 'Name is required'; end if;
  if p_role = 'owner' then raise exception 'There is only one owner (bootstrap_owner)'; end if;
  if p_role = 'staff' and (p_pin is null or p_pin !~ '^[0-9]{4}$') then raise exception 'Staff need a 4-digit PIN'; end if;
  if p_role = 'manager' and coalesce(trim(p_email), '') = '' then raise exception 'Managers need the email they will sign in with'; end if;
  if exists (select 1 from public.staff where lower(name) = lower(trim(p_name)) and active) then
    raise exception '"%" already exists (add a surname or initial so names on the tablet are unique)', p_name;
  end if;
  insert into public.staff (name, role, email, pin_hash)
  values (trim(p_name), p_role, nullif(lower(trim(p_email)), ''),
          extensions.crypt(coalesce(p_pin, encode(extensions.gen_random_bytes(16), 'hex')), extensions.gen_salt('bf')))
  returning id into v;
  insert into public.staff_outlets (staff_id, outlet_id, is_home, is_lead) values (v, o, true, p_lead and p_role = 'staff');
  return v;
end $$;

create function public.admin_add_to_outlet(p_name text, p_outlet text, p_lead boolean default false) returns void
language plpgsql security definer set search_path = public as $$
declare v uuid := public.kq_person_of(p_name);
begin
  insert into public.staff_outlets (staff_id, outlet_id, is_home, is_lead)
  values (v, public.kq_outlet_of(p_outlet), false, p_lead and public.staff_role_of(v) = 'staff')
  on conflict (staff_id, outlet_id) do update set is_lead = excluded.is_lead;
end $$;

create function public.admin_set_pin(p_name text, p_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_pin is null or p_pin !~ '^[0-9]{4}$' then raise exception 'PIN must be 4 digits'; end if;
  update public.staff set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf')) where id = public.kq_person_of(p_name);
end $$;

do $$ declare f text; begin
  foreach f in array array['kq_outlet_of(text)', 'kq_person_of(text)',
    'admin_add_person(text, text, public.staff_role, text, boolean, text)', 'admin_add_to_outlet(text, text, boolean)', 'admin_set_pin(text, text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;
