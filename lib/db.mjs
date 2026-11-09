// Local Postgres 17 (embedded binaries) standing in for Supabase's database. On reset: Supabase roles (shim),
// the real Supabase Auth migrations, then our migrations + seed - the same order as a fresh Supabase project.
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gotrueMigrate } from './stack.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
export const PG_PORT = Number(process.env.KQ_PG_PORT || 54329);
const DB = 'kitchen_quest';
const DATA_DIR = join(ROOT, '.pgdata');

export async function startDatabase({ reset = false } = {}) {
  const ep = new EmbeddedPostgres({ databaseDir: DATA_DIR, user: 'postgres', password: 'postgres', port: PG_PORT, persistent: true,
    onLog: () => {}, onError: (e) => console.error('[pg]', String(e).trim()) });
  if (!existsSync(join(DATA_DIR, 'PG_VERSION'))) await ep.initialise();
  await ep.start();
  const admin = new pg.Client({ host: 'localhost', port: PG_PORT, user: 'postgres', password: 'postgres', database: 'postgres' });
  await admin.connect();
  const exists = (await admin.query('select 1 from pg_database where datname = $1', [DB])).rowCount > 0;
  if (exists && reset) await admin.query(`drop database ${DB} with (force)`);
  const fresh = !exists || reset;
  if (fresh) await admin.query(`create database ${DB}`);
  await admin.end();

  const pool = new pg.Pool({ host: 'localhost', port: PG_PORT, user: 'postgres', password: 'postgres', database: DB, max: 10 });
  if (fresh) {
    await pool.query(readFileSync(join(ROOT, 'local/00_supabase_shim.sql'), 'utf8')); console.log('applied local/00_supabase_shim.sql');
    gotrueMigrate(DB); console.log('applied Supabase Auth migrations (real GoTrue binary)');
    const files = [
      ...readdirSync(join(ROOT, 'supabase/migrations')).filter(f => f.endsWith('.sql')).sort().map(f => `supabase/migrations/${f}`),
      'supabase/seed.sql'];
    for (const f of files) {
      try { await pool.query(readFileSync(join(ROOT, f), 'utf8')); console.log('applied', f); }
      catch (e) { console.error(`FAILED ${f}:`, e.message, e.position ? `(pos ${e.position})` : ''); throw e; }
    }
  }
  return { ep, pool };
}

// Run fn inside a transaction as the Supabase "authenticated" role with the user's JWT sub claim,
// so every RLS policy and guard trigger applies exactly as it would on Supabase.
export async function asUser(pool, authUserId, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('role', $1, true), set_config('request.jwt.claim.sub', $2, true),
                          set_config('request.jwt.claims', $3, true)`,
      [authUserId ? 'authenticated' : 'anon', authUserId || '', JSON.stringify({ sub: authUserId, role: authUserId ? 'authenticated' : 'anon' })]);
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) { await c.query('rollback').catch(() => {}); throw e; }
  finally { c.release(); }
}
