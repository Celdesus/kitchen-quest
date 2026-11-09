-- Scheduled jobs with pg_cron (built into Supabase, free). pg_cron uses UTC.
--   kq-weekly-crown:  Sunday 16:00 UTC = Monday 00:00 AWST -> records the pending weekly winners (idempotent).
--   kq-recurring-jobs: 16:05 UTC daily = 00:05 AWST -> creates today's assignments for recurring jobs with a default assignee.
-- Locally (no pg_cron) the shim provides the same cron.schedule() and server.mjs runs the jobs on this schedule.
do $$ begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
  end if;
end $$;

do $$ begin
  if to_regnamespace('cron') is null then
    raise notice 'pg_cron not available here: schedule crown_weekly_winners() for Sunday 16:00 UTC some other way';
    return;
  end if;
  perform cron.schedule('kq-weekly-crown', '0 16 * * 0', 'select public.crown_weekly_winners()');
  perform cron.schedule('kq-recurring-jobs', '5 16 * * *', 'select public.generate_recurring_assignments()');
end $$;
