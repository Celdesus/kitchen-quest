-- Kitchen Quest: core schema (Supabase-compatible Postgres 15+)
-- Applies unchanged on Supabase. Locally, local/00_supabase_shim.sql supplies auth.uid() and the Supabase roles.

-- Supabase gives anon/authenticated ALL on every new table by default. Kitchen Quest grants table access explicitly
-- (see strict_roles_rls.sql), e.g. nobody may read staff.pin_hash, so switch those defaults off first.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create type public.staff_role        as enum ('staff', 'manager', 'owner');
create type public.shift_slot        as enum ('am', 'pm', 'close');
create type public.job_kind          as enum ('prep', 'cleaning', 'service', 'opening', 'closing', 'deep_clean', 'handover');
create type public.job_recurrence    as enum ('one_off', 'per_shift', 'daily', 'weekly', 'fortnightly', 'monthly', 'as_needed');
-- How the manager checks it before approving: a quick look (self_tick) or a proper inspection (manager). No photos.
create type public.job_verification  as enum ('self_tick', 'manager');
-- pending -> approved | rejected (manager); approved -> reversed (manager, with a reason, if the job wasn't really done)
create type public.completion_status as enum ('pending', 'approved', 'rejected', 'reversed');
create type public.ledger_entry      as enum ('award', 'reversal', 'bonus');
create type public.channel_kind      as enum ('group', 'direct');
create type public.leave_status      as enum ('none', 'approved_leave');
create type public.hours_source      as enum ('manual', 'csv', 'deputy');

-- Outlets (kitchens). The owner sees every outlet plus the group-wide board.
create table public.outlets (
  id          smallint generated always as identity primary key,
  slug           text not null unique,
  name           text not null,
  rollout_order  smallint not null unique,            -- 1 = pilot, 2 = next, ...
  is_active      boolean not null default false,      -- switched on by the owner; inactive outlets are set up but not live
  activated_at   timestamptz,
  created_at     timestamptz not null default now()
);

-- Ranking settings per outlet (outlet_id null = the group-wide board). Values are PLACEHOLDERS until
-- the final rules (mock-job-library-v5) arrive; managers/owner can change them with no schema change.
create table public.outlet_settings (
  id                 uuid primary key default gen_random_uuid(),
  outlet_id          smallint references public.outlets(id) on delete cascade,
  min_hours_to_rank  numeric(5,1) not null default 10.0 check (min_hours_to_rank >= 0),  -- Ivan's setting: 10 h/week
  updated_by         uuid,
  updated_at         timestamptz not null default now(),
  constraint outlet_settings_once unique nulls not distinct (outlet_id)
);

-- Kitchen sections (shared across outlets): prep, line, pastry, dish
create table public.sections (
  id          smallint generated always as identity primary key,
  slug        text not null unique,
  name        text not null,
  colour      text not null default '#2f6f4f',
  sort_order  smallint not null default 0
);

-- Staff. auth_user_id = auth.users.id on Supabase (no FK, so the tablet PIN flow works without email).
-- Staff are never hard-deleted once they have history: set active = false.
create table public.staff (
  id             uuid primary key default gen_random_uuid(),
  auth_user_id   uuid not null unique default gen_random_uuid(),
  name           text not null,
  staff_code     text unique,            -- short code for CSV paste, e.g. 'NB-07'
  external_id    text unique,            -- future roster import (e.g. Deputy employee id); unused for now
  role           public.staff_role not null default 'staff',
  section_id     smallint references public.sections(id) on delete set null,
  started_on     date not null default current_date,      -- rookie tier = first 6 weeks
  pin_hash       text not null,
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);

-- Which outlets each person works at (some staff work at two). A manager manages the outlets they belong to.
-- The owner needs no rows here: they see and manage everything.
create table public.staff_outlets (
  staff_id    uuid not null references public.staff(id) on delete cascade,
  outlet_id   smallint not null references public.outlets(id) on delete cascade,
  is_home     boolean not null default true,
  is_lead     boolean not null default false,   -- shift lead AT THIS OUTLET: can approve/reject/reverse others' ticks here, write/confirm handovers
  primary key (staff_id, outlet_id)
);

-- Rostered shifts: drives points-per-shift ranking and streaks (days off never break a streak)
create table public.roster_shifts (
  id          uuid primary key default gen_random_uuid(),
  outlet_id   smallint not null references public.outlets(id) on delete cascade,
  staff_id    uuid not null references public.staff(id) on delete restrict,
  shift_date  date not null,
  shift       public.shift_slot not null,
  unique (staff_id, shift_date, shift)
);

-- Seasons: group-wide, 10 to 12 game weeks, set by the owner. Starts on a Monday (AWST game week).
create table public.seasons (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  starts_on     date not null check (extract(isodow from starts_on) = 1),
  length_weeks  smallint not null check (length_weeks between 10 and 12),
  ends_on       date generated always as (starts_on + (length_weeks * 7 - 1)) stored,   -- a Sunday
  min_ranked_pct smallint not null default 60 check (min_ranked_pct between 0 and 100),  -- v7: ranked in 60% of weeks to be Season Champion (EXAMPLE)
  set_by        uuid references public.staff(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Hours worked per person, per outlet, per game week (entered by the OWNER only; drives points-per-hour ranking)
create table public.weekly_hours (
  id            uuid primary key default gen_random_uuid(),
  staff_id      uuid not null references public.staff(id) on delete restrict,
  outlet_id     smallint not null references public.outlets(id) on delete cascade,
  week_start    date not null check (extract(isodow from week_start) = 1),   -- Monday (AWST game week)
  hours         numeric(5,2) not null default 0 check (hours between 0 and 120),
  leave_status  public.leave_status not null default 'none',
  source        public.hours_source not null default 'manual',
  external_ref  text,                   -- future import reference (e.g. Deputy timesheet id); null for manual/csv
  entered_by    uuid references public.staff(id) on delete set null,
  updated_at    timestamptz not null default now(),
  constraint weekly_hours_once unique (staff_id, outlet_id, week_start)
);

-- Job library (manager-only to change)
create table public.jobs (
  id                   uuid primary key default gen_random_uuid(),
  outlet_id            smallint not null references public.outlets(id) on delete cascade,
  title                text not null,
  description          text,                                      -- plain-language "how and why"
  kind                 public.job_kind not null,
  section_id           smallint references public.sections(id) on delete set null,  -- null = all sections
  shift                public.shift_slot,                         -- null = any shift
  due_time             time,
  points               integer not null check (points between 0 and 1000),
  is_grim              boolean not null default false,             -- grim-job multiplier already baked into points
  recurrence           public.job_recurrence not null default 'one_off',
  recur_weekday        smallint check (recur_weekday between 1 and 7), -- ISO: 1 = Monday
  verification         public.job_verification not null default 'manager',
  daily_cap            smallint check (daily_cap > 0),             -- e.g. restock max 3 per shift
  default_assignee_id  uuid references public.staff(id) on delete set null,
  active               boolean not null default true,
  created_by           uuid references public.staff(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint weekly_needs_weekday check (recurrence not in ('weekly', 'fortnightly') or recur_weekday is not null)
);

-- A job given to a person for a date (and optionally a shift)
create table public.assignments (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references public.jobs(id) on delete cascade,
  staff_id     uuid not null references public.staff(id) on delete restrict,
  due_date     date not null default (now() at time zone 'Australia/Perth')::date,
  shift        public.shift_slot,
  assigned_by  uuid references public.staff(id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint assignments_once unique nulls not distinct (job_id, staff_id, due_date, shift)
);

-- Tick-offs. Client may supply the id (UUID) so offline retries are idempotent.
-- A tick sits as PENDING and earns nothing until a manager approves it. NO photos, location or audio are stored.
-- Points are awarded by the ledger trigger on approval; a reversal (approved -> reversed) adds a negative entry.
create table public.completions (
  id              uuid primary key default gen_random_uuid(),
  assignment_id   uuid not null references public.assignments(id) on delete cascade,
  staff_id        uuid not null references public.staff(id) on delete restrict,
  note            text,
  status          public.completion_status not null default 'pending',
  completed_at    timestamptz not null default now(),
  reviewed_by     uuid references public.staff(id) on delete set null,
  reviewed_at     timestamptz,
  review_note     text,
  unique (assignment_id),
  constraint reversal_needs_reason check (status <> 'reversed' or length(trim(coalesce(review_note, ''))) >= 3),
  -- Nobody verifies their own completion, so a manager never earns points on a job they signed off.
  constraint no_self_review check (reviewed_by is distinct from staff_id)
);

-- Points ledger: append-only. Reversals are new rows that point at the entry they cancel.
create table public.points_ledger (
  id             bigint generated always as identity primary key,
  staff_id       uuid not null references public.staff(id) on delete restrict,
  outlet_id      smallint not null references public.outlets(id) on delete restrict,  -- outlet the points were earned at
  entry_type     public.ledger_entry not null,
  points         integer not null,
  reason         text not null,                       -- shown to staff: "why did I get this point?"
  completion_id  uuid references public.completions(id) on delete set null,
  reverses_id    bigint unique references public.points_ledger(id),
  awarded_by     uuid references public.staff(id) on delete set null,
  awarded_at     timestamptz not null default now(),
  -- Which game week the points belong to. original_week = the week the job was done (or the award/bonus was given);
  -- credited_week = the week whose board they count on. They differ only when the original week was already signed
  -- off by the owner: then the points go to the current open week, so a signed-off week never changes.
  -- Both are filled by the ledger_set_weeks trigger (migration 2).
  original_week  date not null check (extract(isodow from original_week) = 1),
  credited_week  date not null check (extract(isodow from credited_week) = 1),
  constraint reversal_shape check ((entry_type = 'reversal') = (reverses_id is not null)),
  constraint credit_not_earlier check (credited_week >= original_week),
  -- Nobody earns points they awarded themselves (job awards and bonuses): the approver is never the earner.
  constraint no_self_award check (entry_type = 'reversal' or awarded_by is distinct from staff_id)
);
create index points_ledger_credit_idx on public.points_ledger (credited_week, outlet_id);

-- Weekly reward: free text set by a manager for each week (no fixed catalogue)
create table public.weekly_rewards (
  id          uuid primary key default gen_random_uuid(),
  outlet_id   smallint references public.outlets(id) on delete cascade,   -- null = group-wide board (owner sets)
  week_start  date not null check (extract(isodow from week_start) = 1),  -- Monday (Perth)
  title       text not null check (length(title) between 1 and 120),
  details     text,
  set_by      uuid references public.staff(id) on delete set null,
  updated_at  timestamptz not null default now(),
  constraint weekly_reward_once unique nulls not distinct (outlet_id, week_start)
);

-- Weekly crown. Game week = Monday 00:00 to Sunday 23:59:59 Australia/Perth (AWST, UTC+8, no daylight saving).
-- At Monday 00:00 AWST the system computes a *pending* winner per outlet and for the group-wide board;
-- ONLY the owner confirms or overrides it (audited).
create table public.weekly_crowns (
  id                uuid primary key default gen_random_uuid(),
  outlet_id         smallint references public.outlets(id) on delete cascade,   -- null = group-wide board
  week_start        date not null check (extract(isodow from week_start) = 1),
  winner_id         uuid references public.staff(id) on delete restrict,
  auto_winner_id    uuid references public.staff(id) on delete restrict,   -- what the system picked
  points            integer,
  points_per_hour   numeric(7,2),
  status            text not null default 'pending' check (status in ('pending', 'confirmed')),
  confirmed_by      uuid references public.staff(id) on delete set null,
  confirmed_at      timestamptz,
  overridden        boolean not null default false,
  override_by       uuid references public.staff(id) on delete set null,
  override_reason   text,
  crowned_at        timestamptz not null default now(),
  constraint confirmed_shape check ((status = 'confirmed') = (confirmed_by is not null and confirmed_at is not null)),
  constraint override_needs_reason check (not overridden or (override_reason is not null and override_by is not null)),
  constraint weekly_crown_once unique nulls not distinct (outlet_id, week_start)
);

-- Badges
create table public.badges (
  id           smallint generated always as identity primary key,
  slug         text not null unique,
  name         text not null,
  description  text not null,
  icon         text not null default '🏅'
);
create table public.staff_badges (
  staff_id    uuid not null references public.staff(id) on delete restrict,
  badge_id    smallint not null references public.badges(id) on delete cascade,
  awarded_at  timestamptz not null default now(),
  awarded_by  uuid references public.staff(id) on delete set null,
  note        text,
  primary key (staff_id, badge_id)
);

-- Shift handover: written by the outgoing lead, stays open until the incoming lead confirms
create table public.handovers (
  id                uuid primary key default gen_random_uuid(),
  outlet_id         smallint not null references public.outlets(id) on delete cascade,
  shift_date        date not null,
  shift             public.shift_slot not null,
  written_by        uuid not null references public.staff(id) on delete restrict,
  prep_notes        text,      -- prep done/outstanding, with dates on carry-overs
  equipment_faults  text,
  customer_issues   text,
  deliveries        text,
  staffing          text,
  is_weekend_gap    boolean not null default false,  -- Sat close -> Mon: flagged for stricter follow-up
  created_at        timestamptz not null default now(),
  confirmed_by      uuid references public.staff(id) on delete set null,
  confirmed_at      timestamptz,
  constraint not_self_confirmed check (confirmed_by is null or confirmed_by <> written_by)
);

-- Messaging: group channels (incl. whole-kitchen) and direct messages, with read receipts
create table public.channels (
  id          uuid primary key default gen_random_uuid(),
  kind        public.channel_kind not null,
  outlet_id   smallint references public.outlets(id) on delete cascade,   -- null = group-wide
  name        text,
  is_everyone boolean not null default false,   -- everyone in the outlet (or everyone, if group-wide) can read
  created_by  uuid references public.staff(id) on delete set null,
  created_at  timestamptz not null default now()
);
create table public.channel_members (
  channel_id  uuid not null references public.channels(id) on delete cascade,
  staff_id    uuid not null references public.staff(id) on delete cascade,
  primary key (channel_id, staff_id)
);
create table public.messages (
  id          uuid primary key default gen_random_uuid(),
  channel_id  uuid not null references public.channels(id) on delete cascade,
  sender_id   uuid not null references public.staff(id) on delete restrict,
  body        text not null check (length(body) between 1 and 4000),
  is_memo     boolean not null default false,
  pinned      boolean not null default false,
  created_at  timestamptz not null default now()
);
create table public.message_reads (
  message_id  uuid not null references public.messages(id) on delete cascade,
  staff_id    uuid not null references public.staff(id) on delete cascade,
  read_at     timestamptz not null default now(),
  primary key (message_id, staff_id)
);

-- Admin audit log: every change to jobs, points, weekly rewards, crowns, assignments and staff
create table public.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor_id    uuid,                 -- staff.id of the manager (null = system/seed)
  table_name  text not null,
  row_id      text not null,
  action      text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  old_data    jsonb,
  new_data    jsonb
);

create index on public.staff_outlets (outlet_id);
create index on public.jobs (outlet_id) where active;
create index on public.assignments (staff_id, due_date);
create index on public.assignments (job_id, due_date);
create index on public.completions (status, completed_at);
create index on public.completions (staff_id);
create index on public.points_ledger (outlet_id, awarded_at);
create index on public.points_ledger (staff_id, awarded_at);
create index on public.points_ledger (completion_id);
create index on public.roster_shifts (outlet_id, shift_date);
create index on public.roster_shifts (staff_id, shift_date);
create index on public.weekly_crowns (week_start);
create index on public.weekly_hours (outlet_id, week_start);
create index on public.weekly_hours (week_start, staff_id);
create index on public.handovers (outlet_id, shift_date desc);
create index on public.channels (outlet_id);
create index on public.messages (channel_id, created_at desc);
create index on public.audit_log (table_name, at desc);

create function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create trigger jobs_touch before update on public.jobs for each row execute function public.touch_updated_at();
create trigger seasons_touch before update on public.seasons for each row execute function public.touch_updated_at();
create trigger weekly_hours_touch before update on public.weekly_hours for each row execute function public.touch_updated_at();
create trigger outlet_settings_touch before update on public.outlet_settings for each row execute function public.touch_updated_at();
create trigger weekly_rewards_touch before update on public.weekly_rewards for each row execute function public.touch_updated_at();


-- LATER PHASE (designed, not built): peer shout-outs.
-- create table public.shout_outs (id, giver_id, receiver_id, week_start, reason text not null, removed_by, created_at, unique (giver_id, week_start)).
-- Shout-outs are RECOGNITION AND BADGES ONLY (Team Player, Hype Crew). They never add points and never change
-- points per hour, rankings, crowns or streaks. (This overrides the "+0.1 pts/hr per shout-out" idea in mock-job-library-v7.)
