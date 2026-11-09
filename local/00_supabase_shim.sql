-- LOCAL ONLY. Recreates the Supabase roles and schemas the real Supabase Auth (GoTrue) and PostgREST binaries expect.
-- Supabase Auth's own migrations then create auth.users, auth.uid(), auth.jwt() exactly as on Supabase. Do NOT run on Supabase.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit password 'local-authenticator'; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin login createrole password 'local-auth-admin'; end if;
end $$;
grant anon, authenticated, service_role to authenticator;
create schema if not exists auth authorization supabase_auth_admin;
grant usage on schema auth to anon, authenticated, service_role, postgres;
-- pg_cron stand-in (embedded Postgres has no pg_cron): same cron.schedule()/cron.unschedule()/cron.job shape.
-- The local gateway (server.mjs) runs these jobs on the same UTC schedule; Supabase runs them with real pg_cron.
create schema if not exists cron;
create table if not exists cron.job (jobid bigserial primary key, schedule text not null, command text not null,
  jobname text unique, active boolean not null default true);
create or replace function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid $$;
create or replace function cron.unschedule(job_name text) returns boolean language sql as $$
  with d as (delete from cron.job where jobname = job_name returning 1) select exists (select 1 from d) $$;
-- Supabase's default privileges: anon/authenticated/service_role get ALL on new tables, sequences and functions in public.
-- Reproduced here so local tests see the same grants a real project would (core_schema.sql removes the table/sequence ones).
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
