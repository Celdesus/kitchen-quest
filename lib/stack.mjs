// LOCAL "mini Supabase": the real PostgREST, Supabase Auth (GoTrue) and the real pin-login Edge Function (Deno),
// all pointed at the local Postgres. server.mjs puts them behind one origin with Supabase's paths:
//   /rest/v1/*  -> PostgREST      /auth/v1/*  -> Supabase Auth      /functions/v1/pin-login -> Deno
// Binaries: scripts/get-local-supabase.sh (PostgREST v16.5, Supabase Auth v2.197.0, Deno 2.9.8).
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = new URL('..', import.meta.url).pathname;
export const BIN = process.env.KQ_SB_BIN || join(homedir(), 'bin/sb');
const PG_PORT = Number(process.env.KQ_PG_PORT || 54329);
export const PORTS = { rest: 54330, fn: 54331, auth: 54332 };
// Local-only secrets (Supabase generates its own per project; never reuse these there).
export const JWT_SECRET = process.env.KQ_JWT_SECRET || 'local-only-jwt-secret-kitchen-quest-0123456789';
const jwt = (payload) => { const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${h}.${b}.` + crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64url'); };
export const ANON_KEY = jwt({ iss: 'supabase-local', role: 'anon', iat: 1767225600, exp: 2082758400 });
export const SERVICE_KEY = jwt({ iss: 'supabase-local', role: 'service_role', iat: 1767225600, exp: 2082758400 });
// New-style API keys, like a 2026 Supabase project: not JWTs, sent in the apikey header only. The local gateway
// (server.mjs) swaps them for the role JWTs above, as Supabase's gateway does.
export const PUBLISHABLE_KEY = 'sb_publishable_local_example_only';
export const SECRET_KEY = 'sb_secret_local_example_only';

const authEnv = (db, port, siteUrl) => ({ ...process.env,
  GOTRUE_DB_DRIVER: 'postgres', DATABASE_URL: `postgres://supabase_auth_admin:local-auth-admin@localhost:${PG_PORT}/${db}?search_path=auth&sslmode=disable`,
  GOTRUE_DB_MIGRATIONS_PATH: join(BIN, 'gotrue/migrations'), GOTRUE_SITE_URL: siteUrl, API_EXTERNAL_URL: `${siteUrl}/auth/v1`,
  GOTRUE_JWT_SECRET: JWT_SECRET, GOTRUE_JWT_EXP: '3600', GOTRUE_JWT_AUD: 'authenticated', GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated',
  GOTRUE_JWT_ADMIN_ROLES: 'service_role', GOTRUE_DISABLE_SIGNUP: 'true', GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true', GOTRUE_MAILER_AUTOCONFIRM: 'true',
  GOTRUE_API_HOST: '127.0.0.1', PORT: String(port), GOTRUE_LOG_LEVEL: 'warn',
  // same as Supabase's default: refresh tokens rotate
  GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED: 'true' });

export function checkBinaries() {
  const need = ['postgrest', 'gotrue/auth', 'deno'].filter(b => !existsSync(join(BIN, b)));
  if (need.length) throw new Error(`Missing local Supabase binaries in ${BIN}: ${need.join(', ')}. Run scripts/get-local-supabase.sh`);
}
export function gotrueMigrate(db) {
  checkBinaries();
  execFileSync(join(BIN, 'gotrue/auth'), ['migrate'], { env: authEnv(db, PORTS.auth, 'http://localhost:8787'), stdio: ['ignore', 'ignore', 'pipe'] });
}

export async function startServices({ db, siteUrl, publicUrl }) {
  checkBinaries(); mkdirSync(join(ROOT, 'logs'), { recursive: true });
  const out = (name) => openSync(join(ROOT, `logs/${name}.log`), 'a');
  const procs = []; let stopping = false;
  const run = (name, cmd, args, env) => { const p = spawn(cmd, args, { env, stdio: ['ignore', out(name), out(name)], cwd: ROOT });
    p.on('exit', (code) => { if (!stopping) console.error(`[${name}] exited (${code}); see logs/${name}.log`); }); procs.push(p); return p; };
  run('postgrest', join(BIN, 'postgrest'), [], { ...process.env,
    PGRST_DB_URI: `postgres://authenticator:local-authenticator@localhost:${PG_PORT}/${db}`, PGRST_DB_SCHEMAS: 'public', PGRST_DB_ANON_ROLE: 'anon',
    PGRST_JWT_SECRET: JWT_SECRET, PGRST_SERVER_HOST: '127.0.0.1', PGRST_SERVER_PORT: String(PORTS.rest), PGRST_DB_POOL: '10', PGRST_LOG_LEVEL: 'warn' });
  run('auth', join(BIN, 'gotrue/auth'), ['serve'], authEnv(db, PORTS.auth, siteUrl));
  // The Edge Function talks to "Supabase" through the same public gateway it would use in production.
  run('pin-login', join(BIN, 'deno'), ['run', '--allow-net', '--allow-env', 'scripts/serve-function.ts'], { ...process.env,
    FN_PORT: String(PORTS.fn), SUPABASE_URL: publicUrl,
    SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: PUBLISHABLE_KEY }), SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET_KEY }),
    STAFF_EMAIL_DOMAIN: 'staff.kitchenquest.invalid' });
  const ready = async (url, ok = (r) => r.status < 500) => { for (let i = 0; i < 100; i++) {
    try { if (ok(await fetch(url))) return; } catch {} await new Promise(r => setTimeout(r, 150)); } throw new Error(`not ready: ${url}`); };
  await Promise.all([ready(`http://127.0.0.1:${PORTS.rest}/`), ready(`http://127.0.0.1:${PORTS.auth}/health`, r => r.ok),
    ready(`http://127.0.0.1:${PORTS.fn}/`, () => true)]);
  return { stop: () => { stopping = true; for (const p of procs) p.kill('SIGTERM'); } };
}

// Example data only: give the seeded managers/owner a Supabase Auth email + password login (as Ivan would in the dashboard).
export const EXAMPLE_PASSWORDS = { owner: 'owner-2468', manager: 'manager-9999' };
export async function ensureExampleLogins(pool) {
  const { rows } = await pool.query(`select s.auth_user_id, s.email, s.role from public.staff s
    where s.email is not null and s.active and not exists (select 1 from auth.users u where u.id = s.auth_user_id or lower(u.email) = lower(s.email))`);
  for (const s of rows) {
    const r = await fetch(`http://127.0.0.1:${PORTS.auth}/admin/users`, { method: 'POST',
      headers: { 'content-type': 'application/json', apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ id: s.auth_user_id, email: s.email, password: EXAMPLE_PASSWORDS[s.role], email_confirm: true }) });
    if (!r.ok) console.error('example login for', s.email, r.status, await r.text());
  }
  return rows.length;
}
