// Strict-role tests. Needs the local stack running (npm start). Refusals are checked twice:
// (1) through the Supabase API (PostgREST RPC, same client as the app), (2) straight against Postgres as the Supabase "authenticated" role, proving RLS/triggers
// enforce it even if the API were bypassed. Success-path SQL runs in a transaction that is rolled back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { createClient, ROUTES } from '../public/kq-api.js';

// Same client + calls as the PWA: Supabase RPC under RLS, staff PIN login via the pin-login Edge Function,
// managers/owner via Supabase Auth email + password. Runs against the local stack (npm start).
const API = process.env.KQ_API || 'http://localhost:8787';
const pool = new pg.Pool({ host: 'localhost', port: Number(process.env.KQ_PG_PORT || 54329), user: 'postgres', password: 'postgres', database: 'kitchen_quest' });
const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
const who = (code) => one('select id, auth_user_id from staff where staff_code = $1', [code]);
const ANON = JSON.parse((await (await fetch(`${API}/config.js`)).text()).match(/= (\{.*\});/)[1]).anonKey;
const client = () => { let s = null; return createClient({ url: API, anonKey: ANON, store: { get: () => s, set: (v) => s = v } }); };
const login = async (code, secret) => {
  // staff use the tablet of a switched-on outlet they work at (home first)
  const s = await one(`select s.id, s.role, s.email, so.outlet_id, t.code from staff s left join staff_outlets so on so.staff_id = s.id
    left join outlets o on o.id = so.outlet_id left join outlet_tablets t on t.outlet_id = so.outlet_id
    where s.staff_code = $1 order by o.is_active desc nulls last, so.is_home desc nulls last limit 1`, [code]);
  const c = client();
  if (s.role === 'staff') await c.signInWithPin({ staff_id: s.id, pin: secret, outlet_id: s.outlet_id, tablet_code: s.code });
  else await c.signInWithPassword(s.email, secret);
  return c; };
// Response-like wrapper so tests read naturally: status 200 or the HTTP status PostgREST gave (42501 -> 403, 22023 -> 400)
const call = async (c, method, path, body) => { try { const data = await c.api(path, { method, body }); return { status: 200, json: async () => data }; }
  catch (e) { return { status: e.status, json: async () => ({ error: e.message }) }; } };
// run SQL as a user, always rolled back
async function asRolledBack(code, fn) {
  const u = await who(code); const c = await pool.connect();
  try { await c.query('begin'); await c.query(`select set_config('role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)`, [u.auth_user_id]);
    return await fn(c); } finally { await c.query('rollback'); c.release(); }
}
const denied = async (code, sql, p) => asRolledBack(code, async c => {
  await c.query('savepoint s');
  try { const r = await c.query(sql, p); return { ok: true, rowCount: r.rowCount }; }
  catch (e) { await c.query('rollback to savepoint s'); return { ok: false, code: e.code, message: e.message }; } });

const jobA = () => one(`select id from jobs where outlet_id = 1 limit 1`);
const lastWeek = async () => (await one('select (public.perth_week_start() - 7)::text w')).w;

test('staff cannot edit a job (API 403 + RLS hides the row)', async () => {
  const t = await login('A-03', '1234'); const j = await jobA();
  const r = await call(t, 'PUT', `/api/jobs/${j.id}`, { points: 999 });
  assert.equal(r.status, 403); assert.match((await r.json()).error, /Managers only/);
  const sql = await denied('A-03', 'update jobs set points = 999 where id = $1', [j.id]);
  assert.equal(sql.ok && sql.rowCount, 0, 'RLS: staff update touches 0 rows');
  const ins = await denied('A-03', `insert into jobs (outlet_id, title, kind, points) values (1, 'Hack', 'prep', 500)`);
  assert.equal(ins.ok, false); assert.equal(ins.code, '42501');
  assert.equal((await one('select points from jobs where id = $1', [j.id])).points !== 999, true);
});

test('staff can tick off their own job, but cannot sign anything off', async () => {
  const c = await one(`select c.id, s.staff_code from completions c join staff s on s.id = c.staff_id
                        where s.role = 'staff' and c.status = 'pending' limit 1`);
  assert.ok(c, 'seed has a pending completion');
  const r = await denied(c.staff_code, `update completions set status = 'approved' where id = $1`, [c.id]);
  assert.equal(r.ok, false); assert.equal(r.code, '42501');
  const a = await one(`select a.id from assignments a join staff s on s.id = a.staff_id
                        where s.staff_code = $1 and not exists (select 1 from completions x where x.assignment_id = a.id) limit 1`, [c.staff_code]);
  if (a) {
    const ok = await asRolledBack(c.staff_code, async k => (await k.query(`insert into completions (assignment_id, staff_id)
      values ($1, public.current_staff_id()) returning status`, [a.id])).rows[0]);
    assert.equal(ok.status, 'pending');
    const pre = await denied(c.staff_code, `insert into completions (assignment_id, staff_id, status) values ($1, public.current_staff_id(), 'approved')`, [a.id]);
    assert.equal(pre.ok, false, 'cannot self-approve on insert');
  }
});

test('outlet manager CAN edit jobs at their own outlet, but NOT at another outlet', async () => {
  const own = await asRolledBack('A-M1', c => c.query(`update jobs set points = points + 1 where outlet_id = 1`));
  assert.ok(own.rowCount > 0);
  const other = await denied('A-M1', 'update jobs set points = points + 1 where outlet_id = 2');
  assert.equal(other.rowCount, 0);
});

test('outlet manager is refused when approving or overriding a weekly winner', async () => {
  const t = await login('A-M1', 'manager-9999'); const w = await lastWeek();
  const r1 = await call(t, 'POST', '/api/crowns/confirm', { outlet_id: 1, week_start: w });
  assert.equal(r1.status, 403); assert.match((await r1.json()).error, /owner/i);
  const r2 = await call(t, 'POST', '/api/crowns/override', { outlet_id: 1, week_start: w, winner_id: (await who('A-03')).id, reason: 'x' });
  assert.equal(r2.status, 403);
  const rpc = await denied('A-M1', 'select public.confirm_weekly_crown(1::smallint, $1::date)', [w]);
  assert.equal(rpc.ok, false); assert.equal(rpc.code, '42501'); assert.match(rpc.message, /Only the owner/);
  const upd = await denied('A-M1', `update weekly_crowns set status = 'confirmed' where outlet_id = 1 and week_start = $1`, [w]);
  assert.equal(upd.ok === false || upd.rowCount === 0, true, 'direct crown update refused');
  assert.equal((await one('select status from weekly_crowns where outlet_id = 1 and week_start = $1', [w])).status, 'pending');
});

test('owner can approve a weekly winner (rolled back)', async () => {
  const w = await lastWeek();
  const r = await asRolledBack('OWNER', async c => { await c.query('select public.confirm_weekly_crown(1::smallint, $1::date)', [w]);
    return (await c.query('select status from weekly_crowns where outlet_id = 1 and week_start = $1', [w])).rows[0]; });
  assert.equal(r.status, 'confirmed');
});

test('outlet manager is refused when editing weekly hours (API 403 + DB 42501); can still read them', async () => {
  const t = await login('A-M1', 'manager-9999'); const w = await lastWeek(); const s = await who('A-03');
  const r = await call(t, 'PUT', '/api/hours', { week_start: w, rows: [{ staff_id: s.id, outlet_id: 1, hours: 40 }] });
  assert.equal(r.status, 403); assert.match((await r.json()).error, /owner/i);
  const upd = await denied('A-M1', 'update weekly_hours set hours = 40 where outlet_id = 1 and week_start = $1', [w]);
  assert.equal(upd.ok === false || upd.rowCount === 0, true);
  const ins = await denied('A-M1', `insert into weekly_hours (staff_id, outlet_id, week_start, hours) values ($1, 1, public.perth_week_start(), 10)`, [s.id]);
  assert.equal(ins.ok, false); assert.equal(ins.code, '42501');
  const read = await asRolledBack('A-M1', c => c.query('select count(*)::int n from weekly_hours where outlet_id = 1'));
  assert.ok(read.rows[0].n > 0, 'manager can read own outlet hours');
  const readOther = await asRolledBack('A-M1', c => c.query('select count(*)::int n from weekly_hours where outlet_id = 2'));
  assert.equal(readOther.rows[0].n, 0, 'manager cannot see other outlets\' hours');
});

test('staff see only their own hours', async () => {
  const r = await asRolledBack('A-03', c => c.query('select distinct staff_id from weekly_hours'));
  const me = await who('A-03'); assert.ok(r.rows.every(x => x.staff_id === me.id));
});

test('owner can edit an unsigned week\'s hours, but hours lock once the winner is signed off', async () => {
  const s = await who('A-03');
  const open = await asRolledBack('OWNER', c => c.query(`insert into weekly_hours (staff_id, outlet_id, week_start, hours) values ($1, 1, public.perth_week_start() - 7, 12)
    on conflict (staff_id, outlet_id, week_start) do update set hours = 12`, [s.id]));
  assert.equal(open.rowCount, 1);
  const locked = await denied('OWNER', `update weekly_hours set hours = hours + 1 where outlet_id = 1 and week_start = public.perth_week_start() - 14`);
  assert.equal(locked.ok, false); assert.match(locked.message, /locked/);
});

test('points ledger is append-only; reversal is a new row', async () => {
  const l = await one(`select id from points_ledger where entry_type = 'award' and outlet_id = 1 and not exists (select 1 from points_ledger r where r.reverses_id = points_ledger.id) limit 1`);
  const del = await denied('OWNER', 'delete from points_ledger where id = $1', [l.id]); assert.equal(del.ok, false);
  const r = await asRolledBack('A-M1', async c => { await c.query(`select public.reverse_points($1, 'test')`, [l.id]);
    return (await c.query('select sum(points)::int s from points_ledger where id = $1 or reverses_id = $1', [l.id])).rows[0]; });
  assert.equal(r.s, 0);
});

test('admin changes are written to the audit log with old and new values', async () => {
  const owner = await who('OWNER');
  const r = await asRolledBack('A-M1', async c => { const j = (await c.query('select id from jobs where outlet_id = 1 limit 1')).rows[0];
    await c.query('update jobs set points = 77 where id = $1', [j.id]);
    await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [owner.auth_user_id]);   // read back as the owner
    return (await c.query(`select a.old_data->>'points' o, a.new_data->>'points' n, s.staff_code from audit_log a join staff s on s.id = a.actor_id
      where table_name = 'jobs' and row_id = $1 order by a.id desc limit 1`, [j.id])).rows[0]; });
  assert.equal(r.n, '77'); assert.equal(r.staff_code, 'A-M1'); assert.notEqual(r.o, '77');
});

test('seasons: owner-only, and length must be 10 to 12 weeks', async () => {
  const t = await login('A-M1', 'manager-9999');
  const r = await call(t, 'PUT', '/api/seasons', { name: 'x', starts_on: '2027-03-01', length_weeks: 10 });
  assert.equal(r.status, 403);
  const mgr = await denied('A-M1', `insert into seasons (name, starts_on, length_weeks) values ('x', date '2027-03-01', 10)`);
  assert.equal(mgr.ok, false); assert.equal(mgr.code, '42501');
  const tooShort = await denied('OWNER', `insert into seasons (name, starts_on, length_weeks) values ('x', date '2027-03-01', 9)`);
  assert.equal(tooShort.ok, false); assert.equal(tooShort.code, '23514');
  const ok = await asRolledBack('OWNER', c => c.query(`insert into seasons (name, starts_on, length_weeks) values ('S2', date '2027-03-01', 10)`));
  assert.equal(ok.rowCount, 1);
});

test('only the owner can switch an outlet on', async () => {
  const r = await denied('A-M1', 'select public.set_outlet_active(2::smallint, true)');
  assert.equal(r.ok, false); assert.equal(r.code, '42501');
  const ok = await asRolledBack('OWNER', async c => { await c.query('select public.set_outlet_active(2::smallint, true)');
    return (await c.query('select is_active from outlets where id = 2')).rows[0]; });
  assert.equal(ok.is_active, true);
});

test('audit log is owner-only: a manager is refused (API 403, RLS shows 0 rows)', async () => {
  const t = await login('A-M1', 'manager-9999');
  const r = await call(t, 'GET', '/api/audit'); assert.equal(r.status, 403); assert.match((await r.json()).error, /owner/i);
  const sql = await asRolledBack('A-M1', c => c.query('select count(*)::int n from audit_log'));
  assert.equal(sql.rows[0].n, 0, 'manager sees no audit rows');
  const own = await asRolledBack('OWNER', c => c.query('select count(*)::int n from audit_log'));
  assert.ok(own.rows[0].n > 0, 'owner sees the audit log');
  const ok = await call(await login('OWNER', 'owner-2468'), 'GET', '/api/audit'); assert.equal(ok.status, 200);
});

test('late approval in a signed-off week credits the open week and never changes the locked week', async () => {
  const c = await one(`select c.id, c.staff_id, perth_week_start(c.completed_at)::text as wk, j.points from completions c
    join assignments a on a.id = c.assignment_id join jobs j on j.id = a.job_id
   where c.status = 'pending' and j.outlet_id = 1 and public.week_locked(1::smallint, perth_week_start(c.completed_at)) limit 1`);
  assert.ok(c, 'seed has a pending completion from a signed-off week');
  const r = await asRolledBack('A-M1', async k => {
    const board = async (w) => (await k.query(`select coalesce(sum(points), 0)::int p from weekly_board where outlet_id = 1 and week_start = $1::date`, [w])).rows[0].p;
    const open = (await k.query('select public.perth_week_start()::text w')).rows[0].w;
    const lockedBefore = await board(c.wk), openBefore = await board(open);
    await k.query(`update completions set status = 'approved' where id = $1`, [c.id]);
    const led = (await k.query(`select original_week::text, credited_week::text, points, reason from points_ledger where completion_id = $1`, [c.id])).rows[0];
    return { led, open, lockedBefore, lockedAfter: await board(c.wk), openBefore, openAfter: await board(open) };
  });
  assert.equal(r.led.original_week, c.wk); assert.equal(r.led.credited_week, r.open);
  assert.equal(r.lockedAfter, r.lockedBefore, 'signed-off week unchanged');
  assert.equal(r.openAfter - r.openBefore, c.points, 'points land in the open week');
  assert.match(r.led.reason, /already signed off/);
  const api = await (await call(await login('A-M1', 'manager-9999'), 'GET', '/api/approvals?outlet=1')).json();
  assert.equal(api.find(x => x.id === c.id).week_locked, true, 'approvals queue flags it');
});

test('hours: current week opens Sunday 18:00 AWST; owner refused before then', async () => {
  const w = await one(`select public.perth_week_start()::text w,
     public.hours_entry_open(public.perth_week_start(), ((public.perth_week_start() + 6) + time '17:59') at time zone 'Australia/Perth') before,
     public.hours_entry_open(public.perth_week_start(), ((public.perth_week_start() + 6) + time '18:00') at time zone 'Australia/Perth') at6pm,
     public.hours_entry_open(public.perth_week_start() - 7) last_week, public.hours_entry_open(public.perth_week_start()) now_open`);
  assert.equal(w.before, false); assert.equal(w.at6pm, true); assert.equal(w.last_week, true);
  const s = await who('A-03');
  const ins = await denied('OWNER', `insert into weekly_hours (staff_id, outlet_id, week_start, hours) values ($1, 1, public.perth_week_start(), 12)`, [s.id]);
  if (w.now_open) assert.equal(ins.ok, true); else { assert.equal(ins.ok, false); assert.match(ins.message, /Sunday 18:00 AWST/); }
});

test('crown sign-off warns about missing hours / pending approvals but does not block', async () => {
  const w = await lastWeek();
  const rd = (await one('select public.crown_readiness(1::smallint, $1::date) r', [w])).r;
  assert.ok(rd.missing_hours_count > 0 && rd.pending_count > 0, 'seed leaves items missing');
  assert.equal(rd.all_clear, false); assert.equal(typeof rd.unranked_count, 'number');
  const crowns = await (await call(await login('OWNER', 'owner-2468'), 'GET', `/api/crowns?week=${w}`)).json();
  assert.equal(crowns.find(c => c.outlet_id === 1).readiness.missing_hours_count, rd.missing_hours_count);
  const ok = await asRolledBack('OWNER', async c => { await c.query('select public.confirm_weekly_crown(1::smallint, $1::date)', [w]);
    return (await c.query('select status from weekly_crowns where outlet_id = 1 and week_start = $1', [w])).rows[0]; });
  assert.equal(ok.status, 'confirmed');
});

test('nobody can approve their own completion (guard + DB CHECK), even a manager', async () => {
  const a = await one(`select a.id from assignments a join staff s on s.id = a.staff_id join jobs j on j.id = a.job_id
    where s.staff_code = 'A-M1' and j.outlet_id = 1 and not exists (select 1 from completions c where c.assignment_id = a.id) limit 1`);
  assert.ok(a, 'manager A-M1 has an unticked job in the seed');
  const r = await asRolledBack('A-M1', async c => {
    const ins = (await c.query(`insert into completions (assignment_id, staff_id) values ($1, public.current_staff_id()) returning id, status`, [a.id])).rows[0];
    await c.query('savepoint s');
    try { await c.query(`update completions set status = 'approved' where id = $1`, [ins.id]); return { ok: true }; }
    catch (e) { return { ok: false, code: e.code, msg: e.message, status: ins.status }; } });
  assert.equal(r.status, 'pending'); assert.equal(r.ok, false); assert.equal(r.code, '42501'); assert.match(r.msg, /own tick/);
  // Even bypassing the API and guards (service role), the table CHECK refuses approver = completer
  const c = await pool.connect();
  try { await c.query('begin');
    const x = (await c.query(`select id, staff_id from completions where status = 'approved' limit 1`)).rows[0];
    await assert.rejects(c.query('update completions set reviewed_by = staff_id where id = $1', [x.id]), e => e.code === '23514' && /no_self_review/.test(e.message));
  } finally { await c.query('rollback'); c.release(); }
});

test('a manager who signs off a job earns no points for it; nobody can award themselves points', async () => {
  const a = await one(`select a.id from assignments a join staff s on s.id = a.staff_id join jobs j on j.id = a.job_id
    where s.staff_code = 'A-M1' and j.outlet_id = 1 and not exists (select 1 from completions c where c.assignment_id = a.id) limit 1`);
  const m1 = await who('A-M1'), m2 = await who('A-M2');
  const r = await asRolledBack('A-M1', async c => {
    const comp = (await c.query(`insert into completions (assignment_id, staff_id) values ($1, public.current_staff_id()) returning id`, [a.id])).rows[0];
    await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [m2.auth_user_id]);   // the other manager approves
    await c.query(`update completions set status = 'approved' where id = $1`, [comp.id]);
    const led = (await c.query('select staff_id, awarded_by from points_ledger where completion_id = $1', [comp.id])).rows;
    await c.query('savepoint s');
    let bonus; try { await c.query(`insert into points_ledger (staff_id, outlet_id, entry_type, points, reason, awarded_by) values ($1, 1, 'bonus', 50, 'me', $1)`, [m2.id]); bonus = 'ok'; }
    catch (e) { bonus = e.code + ' ' + e.message; }
    return { led, bonus };
  });
  assert.equal(r.led.length, 1); assert.equal(r.led[0].staff_id, m1.id, 'points go to the person who did the job');
  assert.equal(r.led[0].awarded_by, m2.id); assert.notEqual(r.led[0].staff_id, r.led[0].awarded_by, 'approver earns nothing');
  assert.notEqual(r.bonus, 'ok', 'self-bonus refused'); 
});

test('managers and leads are on the boards; the owner is not; min hours is 10', async () => {
  const w = await lastWeek();
  const b = await one(`select count(*) filter (where s.role = 'manager' and b.ranked)::int mgr, count(*) filter (where exists (select 1 from staff_outlets x where x.staff_id = s.id and x.is_lead) and b.ranked)::int leads,
      count(*) filter (where s.role = 'owner')::int owner, min(b.min_hours)::float minh
    from weekly_board b join staff s on s.id = b.staff_id where b.week_start = $1`, [w]);
  assert.ok(b.mgr > 0, 'managers ranked'); assert.ok(b.leads > 0, 'leads ranked'); assert.equal(b.owner, 0); assert.equal(b.minh, 10);
  const st = await one('select count(*)::int n, min(min_hours_to_rank)::float lo, max(min_hours_to_rank)::float hi from outlet_settings');
  assert.equal(st.n, 5); assert.equal(st.lo, 10); assert.equal(st.hi, 10);
});

// --- Approval flow, end to end through the API: tick -> pending (0 pts) -> reject | approve -> reverse ---
const freshTick = async (code = null) => {
  const a = await one(`select a.id, s.staff_code from assignments a join staff s on s.id = a.staff_id and s.role = 'staff' and ($1::text is null or s.staff_code = $1)
     and ($1::text is not null or not exists (select 1 from staff_outlets x where x.staff_id = s.id and x.is_lead))
    join jobs j on j.id = a.job_id where j.outlet_id = 1 and a.due_date = public.perth_today()
     and not exists (select 1 from completions c where c.assignment_id = a.id) order by random() limit 1`, [code]);
  assert.ok(a, 'an unticked job today');
  const st = await login(a.staff_code, '1234');
  const r = await call(st, 'POST', '/api/completions', { assignment_id: a.id }); assert.equal(r.status, 200);
  const c = await r.json(); assert.equal(c.status, 'pending');
  assert.equal((await one('select count(*)::int n from points_ledger where completion_id = $1', [c.id])).n, 0, 'pending earns nothing');
  return { id: c.id, staffToken: st, staff: a.staff_code };
};

test('reject: a manager rejects a pending tick; no points; staff cannot approve or re-open it', async () => {
  const t = await freshTick(); const m = await login('A-M1', 'manager-9999');
  const self = await call(t.staffToken, 'POST', `/api/completions/${t.id}/review`, { status: 'approved' }); assert.equal(self.status, 403);
  const r = await call(m, 'POST', `/api/completions/${t.id}/review`, { status: 'rejected', review_note: 'Bins still full' });
  assert.equal(r.status, 200); assert.equal((await r.json()).status, 'rejected');
  const row = await one(`select c.status, c.review_note, (select count(*)::int from points_ledger l where l.completion_id = c.id) n from completions c where id = $1`, [t.id]);
  assert.deepEqual([row.status, row.review_note, row.n], ['rejected', 'Bins still full', 0]);
  const again = await call(m, 'POST', `/api/completions/${t.id}/review`, { status: 'approved' });
  assert.equal(again.status, 403, 'rejected is final; no sneaky approve later');
  const mine = await (await call(t.staffToken, 'GET', '/api/my-jobs')).json();
  assert.equal(mine.find(j => j.completion_id === t.id).status, 'rejected', 'staff sees it was not approved');
});

test('reverse: approved points are taken back with a reason, logged, and staff/self-reversal refused', async () => {
  const t = await freshTick(); const m = await login('A-M1', 'manager-9999');
  const ok = await call(m, 'POST', `/api/completions/${t.id}/review`, { status: 'approved' }); assert.equal(ok.status, 200);
  const award = await one(`select id, points, credited_week::text cw from points_ledger where completion_id = $1 and entry_type = 'award'`, [t.id]);
  assert.ok(award.points > 0, 'approval awards points');
  const listed = await (await call(m, 'GET', '/api/approved?outlet=1')).json(); assert.ok(listed.some(x => x.id === t.id), 'shows in recently approved');
  const noReason = await call(m, 'POST', `/api/completions/${t.id}/reverse`, { reason: '' }); assert.equal(noReason.status, 400);
  const byStaff = await call(t.staffToken, 'POST', `/api/completions/${t.id}/reverse`, { reason: 'trying it on' }); assert.equal(byStaff.status, 403);
  const r = await call(m, 'POST', `/api/completions/${t.id}/reverse`, { reason: 'Bins were not actually emptied' }); assert.equal(r.status, 200);
  const rev = await one(`select l.points, l.reason, l.reverses_id, l.credited_week::text cw, s.staff_code by from points_ledger l join staff s on s.id = l.awarded_by
    where l.completion_id = $1 and l.entry_type = 'reversal'`, [t.id]);
  assert.equal(rev.points, -award.points); assert.equal(Number(rev.reverses_id), Number(award.id)); assert.equal(rev.by, 'A-M1');
  assert.match(rev.reason, /Bins were not actually emptied/); assert.equal(rev.cw, award.cw, 'open week: reversal lands in the same week');
  assert.equal((await one('select sum(points)::int s from points_ledger where completion_id = $1', [t.id])).s, 0, 'net zero');
  assert.equal((await one('select status from completions where id = $1', [t.id])).status, 'reversed');
  const twice = await call(m, 'POST', `/api/completions/${t.id}/reverse`, { reason: 'again please' }); assert.equal(twice.status, 403, 'cannot reverse twice');
  const audit = await one(`select count(*) filter (where table_name = 'points_ledger' and new_data->>'entry_type' = 'reversal')::int ledger,
      count(*) filter (where table_name = 'completions' and new_data->>'status' = 'reversed')::int comp
    from audit_log where row_id in ($1::text, (select id::text from points_ledger where completion_id = $1::uuid and entry_type = 'reversal'))`, [t.id]);
  assert.ok(audit.ledger >= 1 && audit.comp >= 1, 'reversal and status change are audit-logged');
  const mine = await (await call(t.staffToken, 'GET', '/api/my-points')).json();
  assert.ok(mine.some(p => p.points === -award.points && /Reversed/.test(p.reason)), 'staff can see why points were taken back');
});

test('reverse in a signed-off week: the negative entry goes to the open week; the locked week never changes', async () => {
  const c = await one(`select c.id, perth_week_start(c.completed_at)::text wk from completions c join assignments a on a.id = c.assignment_id
    join jobs j on j.id = a.job_id join staff s on s.id = c.staff_id
   where c.status = 'approved' and j.outlet_id = 1 and s.role = 'staff' and public.week_locked(1::smallint, perth_week_start(c.completed_at))
     and not exists (select 1 from points_ledger r where r.completion_id = c.id and r.entry_type = 'reversal') limit 1`);
  const r = await asRolledBack('A-M1', async k => {
    const board = async (w) => (await k.query(`select coalesce(sum(points), 0)::int p from weekly_board where outlet_id = 1 and week_start = $1::date`, [w])).rows[0].p;
    const before = await board(c.wk);
    await k.query(`select public.reverse_completion($1, 'Spot check found it not done')`, [c.id]);
    const led = (await k.query(`select original_week::text ow, credited_week::text cw from points_ledger where completion_id = $1 and entry_type = 'reversal' order by id desc limit 1`, [c.id])).rows[0];
    return { before, after: await board(c.wk), led, open: (await k.query('select perth_week_start()::text w')).rows[0].w };
  });
  assert.equal(r.after, r.before, 'signed-off week unchanged'); assert.equal(r.led.cw, r.open); assert.equal(r.led.ow, c.wk);
});

test('no photo columns remain anywhere', async () => {
  const n = await one(`select count(*)::int n from information_schema.columns where table_schema = 'public' and column_name ilike '%photo%'`);
  assert.equal(n.n, 0);
});

// --- Shift leads (staff_outlets.is_lead, per outlet) sign off like managers, but never their own tick and never edit jobs ---
const leadAt = (outlet) => one(`select s.staff_code from staff s join staff_outlets so on so.staff_id = s.id
  where so.outlet_id = $1 and so.is_lead and s.active order by s.staff_code limit 1`, [outlet]);

test('seed: every active outlet has at least one shift lead', async () => {
  const r = await one(`select count(*)::int n from outlets o where o.is_active
    and not exists (select 1 from staff_outlets so join staff s on s.id = so.staff_id where so.outlet_id = o.id and so.is_lead and s.active)`);
  assert.equal(r.n, 0);
});

test('lead approves someone else\'s tick; the ticker gets the points, the lead gets none', async () => {
  const lead = await leadAt(1); const t = await freshTick(); const L = await login(lead.staff_code, '1234');
  const q = await (await call(L, 'GET', '/api/approvals?outlet=1')).json(); assert.ok(q.some(x => x.id === t.id), 'in the lead\'s queue');
  const r = await call(L, 'POST', `/api/completions/${t.id}/review`, { status: 'approved' }); assert.equal(r.status, 200);
  const led = await one(`select l.points, s.staff_code who, b.staff_code by from points_ledger l join staff s on s.id = l.staff_id
    join staff b on b.id = l.awarded_by where l.completion_id = $1 and l.entry_type = 'award'`, [t.id]);
  assert.ok(led.points > 0); assert.equal(led.who, t.staff); assert.equal(led.by, lead.staff_code);
  const mine = await one(`select count(*)::int n from points_ledger l join staff s on s.id = l.staff_id where l.completion_id = $1 and s.staff_code = $2`, [t.id, lead.staff_code]);
  assert.equal(mine.n, 0, 'approver earns nothing for it');
  // the lead can also reject and reverse at their outlet
  const t2 = await freshTick(); assert.equal((await call(L, 'POST', `/api/completions/${t2.id}/review`, { status: 'rejected', review_note: 'Not done yet' })).status, 200);
  assert.equal((await call(L, 'POST', `/api/completions/${t.id}/reverse`, { reason: 'Checked again, not done' })).status, 200);
  assert.equal((await one('select sum(points)::int s from points_ledger where completion_id = $1', [t.id])).s, 0);
});

test('lead is refused approving, rejecting or reversing their own tick; another lead or a manager can', async () => {
  const lead = await leadAt(1);
  await pool.query(`insert into assignments (job_id, staff_id, due_date, shift) select j.id, s.id, public.perth_today(), 'pm'
    from jobs j, staff s where j.outlet_id = 1 and j.active and s.staff_code = $1
     and not exists (select 1 from assignments a where a.job_id = j.id and a.staff_id = s.id and a.due_date = public.perth_today()) limit 1`, [lead.staff_code]);
  const t = await freshTick(lead.staff_code); const L = t.staffToken;
  const q = await (await call(L, 'GET', '/api/approvals?outlet=1')).json(); assert.ok(!q.some(x => x.id === t.id), 'own tick not in own queue');
  for (const status of ['approved', 'rejected'])
    assert.equal((await call(L, 'POST', `/api/completions/${t.id}/review`, { status, review_note: 'self' })).status, 403, status);
  // DB level too, bypassing the API
  const db = await denied(lead.staff_code, `update completions set status = 'approved' where id = $1`, [t.id]);
  assert.equal(db.ok, false); assert.equal(db.code, '42501'); assert.match(db.message, /own tick/);
  const other = await one(`select s.staff_code from staff s join staff_outlets so on so.staff_id = s.id where so.outlet_id = 1 and so.is_lead and s.staff_code <> $1 limit 1`, [lead.staff_code]);
  const O = await login(other.staff_code, '1234');
  assert.equal((await call(O, 'POST', `/api/completions/${t.id}/review`, { status: 'approved' })).status, 200, 'another lead approves it');
  assert.equal((await call(L, 'POST', `/api/completions/${t.id}/reverse`, { reason: 'reverse my own' })).status, 403, 'cannot reverse own');
});

test('lead is refused adding or editing jobs (managers only), and cannot sign off at another outlet', async () => {
  const lead = await leadAt(1); const L = await login(lead.staff_code, '1234');
  const job = await one(`select id from jobs where outlet_id = 1 limit 1`);
  assert.equal((await call(L, 'PUT', `/api/jobs/${job.id}`, { points: 99 })).status, 403);
  assert.equal((await call(L, 'POST', '/api/jobs', { outlet_id: 1, title: 'Lead job', points: 5 })).status, 403);
  const upd = await denied(lead.staff_code, `update jobs set points = 99 where id = $1`, [job.id]);
  assert.equal(upd.ok && upd.rowCount, 0, 'RLS: a lead\'s job update touches nothing');
  const ins = await denied(lead.staff_code, `insert into jobs (outlet_id, title, points, kind) select 1, 'Lead job', 5, kind from jobs limit 1`);
  assert.equal(ins.ok, false); assert.equal(ins.code, '42501');
  const elsewhere = await one(`select c.id from completions c join assignments a on a.id = c.assignment_id join jobs j on j.id = a.job_id
    where c.status = 'pending' and j.outlet_id <> 1 limit 1`);
  if (elsewhere) { const u = await denied(lead.staff_code, `update completions set status = 'approved' where id = $1`, [elsewhere.id]);
    assert.equal(u.ok && u.rowCount, 0, 'invisible at another outlet'); }
});

// --- Supabase port: logins, tablets, exposure, schedules ---
const rawFetch = (path, body, key = ANON, extra = {}) => fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: key,
  authorization: `Bearer ${key}`, ...extra }, body: JSON.stringify(body) });

test('PIN login: needs the outlet tablet code; makes a Supabase Auth user with the staff member\'s id; managers cannot use PINs', async () => {
  const st = await one(`select s.id, s.auth_user_id from staff s where staff_code = 'A-04'`);
  const bad = await rawFetch('/functions/v1/pin-login', { staff_id: st.id, pin: '1234', outlet_id: 1, tablet_code: 'WRONG' });
  assert.equal(bad.status, 401); assert.match((await bad.json()).error, /tablet/i);
  const ok = await rawFetch('/functions/v1/pin-login', { staff_id: st.id, pin: '1234', outlet_id: 1, tablet_code: 'example-a' });
  assert.equal(ok.status, 200); const sess = await ok.json(); assert.ok(sess.access_token && sess.refresh_token);
  const u = await one(`select u.id, u.email from auth.users u where u.id = $1`, [st.auth_user_id]);
  assert.ok(u, 'auth user id = staff.auth_user_id'); assert.match(u.email, /@staff\.kitchenquest\.invalid$/);
  const mgr = await one(`select id from staff where staff_code = 'A-M1'`);
  const m = await rawFetch('/functions/v1/pin-login', { staff_id: mgr.id, pin: '9999', outlet_id: 1, tablet_code: 'EXAMPLE-A' });
  assert.equal(m.status, 401, 'managers sign in with email + password, not a PIN');
  const pre = await fetch(`${API}/functions/v1/pin-login`, { method: 'OPTIONS' }); assert.equal(pre.status, 200);
  assert.ok(pre.headers.get('access-control-allow-origin'), 'CORS preflight for the Pages origin');
});

test('PIN lockout: 5 wrong PINs locks that person for 15 minutes, even with the right PIN', async () => {
  const st = await one(`select id from staff where staff_code = 'A-06'`);
  try {
    for (let i = 0; i < 5; i++) assert.equal((await rawFetch('/functions/v1/pin-login', { staff_id: st.id, pin: '0000', outlet_id: 1, tablet_code: 'EXAMPLE-A' })).status, 401);
    const r = await rawFetch('/functions/v1/pin-login', { staff_id: st.id, pin: '1234', outlet_id: 1, tablet_code: 'EXAMPLE-A' });
    assert.equal(r.status, 401); assert.match((await r.json()).error, /Too many/);
    assert.ok((await one('select locked_until > now() + interval \'14 minutes\' as l from pin_attempts where staff_id = $1', [st.id])).l);
  } finally { await pool.query('delete from pin_attempts where staff_id = $1', [st.id]); }
});

test('tablet roster: names only with the tablet code; PIN checks and the API are not reachable without signing in', async () => {
  const c = client();
  assert.ok((await c.roster(1, 'EXAMPLE-A')).length > 10); assert.equal(await c.roster(1, 'guess'), null);
  assert.equal(await c.roster(2, 'EXAMPLE-B'), null, 'outlet not switched on yet');
  const st = await one(`select id from staff where staff_code = 'A-03'`);
  assert.equal((await rawFetch('/rest/v1/rpc/verify_staff_pin', { p_staff_id: st.id, p_pin: '1234' })).status, 401);
  assert.equal((await rawFetch('/rest/v1/rpc/pin_login_check', { p_staff: st.id, p_pin: '1234', p_outlet: 1, p_code: 'EXAMPLE-A' })).status, 401);
  assert.equal((await rawFetch('/rest/v1/rpc/api_board', { p: {} })).status, 401, 'anon cannot read boards');
  assert.equal((await rawFetch('/rest/v1/rpc/kq_rows', { q: 'select 1' })).status, 404, 'query helper is not exposed');
  const staff = await login('A-03', '1234');
  assert.equal((await staff.rpc('verify_staff_pin', { p_staff_id: st.id, p_pin: '1234' }).catch(e => e)).status, 403, 'signed-in users cannot test PINs either');
  const signup = await rawFetch('/auth/v1/signup', { email: 'someone@example.com', password: 'abcdefgh' });
  assert.notEqual(signup.status, 200, 'public sign-up is off');
});

test('every app route maps to an RPC that signed-in users can call and anon cannot', async () => {
  for (const [, , fn] of ROUTES) {
    const r = await one(`select has_function_privilege('authenticated', p.oid, 'execute') a, has_function_privilege('anon', p.oid, 'execute') n,
      prosecdef from pg_proc p where p.proname = $1 and p.pronamespace = 'public'::regnamespace`, [fn]);
    assert.ok(r, `${fn} exists`); assert.ok(r.a && !r.n, `${fn}: authenticated only`); assert.equal(r.prosecdef, false, `${fn} runs as the caller (RLS applies)`);
  }
});

test('manager email login: a dashboard-created user (random id) links to the staff row by email; staff cannot set emails', async () => {
  const email = `test.manager.${Date.now()}@example.com`;
  const s = await one(`insert into staff (name, staff_code, role, email, pin_hash) values ('Test Manager (EXAMPLE)', $1, 'manager', $2, 'x') returning id`, ['T-' + Date.now(), email]);
  await pool.query(`insert into staff_outlets (staff_id, outlet_id) values ($1, 1)`, [s.id]);
  try {
    const { SERVICE_KEY } = await import('../lib/stack.mjs');
    const r = await fetch(`${API}/auth/v1/admin/users`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ email, password: 'a-good-password-1', email_confirm: true }) });
    assert.equal(r.status, 200);
    const c = client(); await c.signInWithPassword(email, 'a-good-password-1');
    const me = await c.api('/api/me'); assert.equal(me.user.name, 'Test Manager (EXAMPLE)'); assert.equal(me.user.role, 'manager');
    assert.equal((await c.signInWithPassword(email, 'wrong-password').catch(e => e)).message, 'Wrong email or password');
    const d = await denied('A-M1', `update staff set email = 'x@example.com' where staff_code = 'A-03'`);
    assert.equal(d.ok, false, 'only the owner sets login emails');
  } finally {
    await pool.query(`delete from auth.users where lower(email) = $1`, [email]);
    await pool.query(`delete from staff_outlets where staff_id = $1`, [s.id]); await pool.query(`delete from staff where id = $1`, [s.id]);
  }
});

test('pg_cron: weekly winners scheduled at Sunday 16:00 UTC (= Monday 00:00 AWST); recurring jobs daily 00:05 AWST', async () => {
  const j = await one(`select schedule, command from cron.job where jobname = 'kq-weekly-crown'`);
  assert.equal(j.schedule, '0 16 * * 0'); assert.match(j.command, /crown_weekly_winners\(\)/);
  const t = await one(`select to_char((timestamptz '2026-11-08 16:00:00+00') at time zone 'Australia/Perth', 'Dy HH24:MI') as perth`);
  assert.equal(t.perth, 'Mon 00:00');
  assert.equal((await one(`select schedule from cron.job where jobname = 'kq-recurring-jobs'`)).schedule, '5 16 * * *');
});

test('Supabase default grants are switched off: nobody can read PIN hashes; anon has no table access', async () => {
  const r = await one(`select has_column_privilege('authenticated', 'public.staff', 'pin_hash', 'select') a_pin,
    has_column_privilege('anon', 'public.staff', 'pin_hash', 'select') n_pin, has_table_privilege('anon', 'public.staff', 'select') n_staff,
    has_table_privilege('anon', 'public.completions', 'select') n_comp, has_table_privilege('anon', 'public.outlet_tablets', 'select') n_tab,
    has_table_privilege('authenticated', 'public.pin_attempts', 'select') a_att`);
  assert.deepEqual(r, { a_pin: false, n_pin: false, n_staff: false, n_comp: false, n_tab: false, a_att: false });
  const c = await login('A-03', '1234'); const t = c.session().access_token;
  const res = await fetch(`${API}/rest/v1/staff?select=pin_hash&limit=1`, { headers: { apikey: ANON, authorization: `Bearer ${t}` } });
  assert.ok([401, 403].includes(res.status), `PostgREST refuses pin_hash (got ${res.status})`);
});

test.after(() => pool.end());

test('go-live helpers (SQL editor only): add staff with a PIN, leads, managers with email; not callable from the app', async () => {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const id = (await c.query(`select public.admin_add_person('Test Person Example', 'Boughshed Kitchen', 'staff', '4821', true) id`)).rows[0].id;
    const row = (await c.query(`select s.role, s.email, so.is_lead, so.is_home, public.verify_staff_pin(s.id, '4821') is not null ok, public.verify_staff_pin(s.id, '1111') is not null bad
      from staff s join staff_outlets so on so.staff_id = s.id where s.id = $1`, [id])).rows[0];
    assert.deepEqual(row, { role: 'staff', email: null, is_lead: true, is_home: true, ok: true, bad: false });
    await c.query(`select public.admin_add_to_outlet('test person example', 'monkey-bar')`);
    await c.query(`select public.admin_set_pin('Test Person Example', '9090')`);
    assert.equal((await c.query(`select count(*)::int n from staff_outlets where staff_id = $1`, [id])).rows[0].n, 2);
    assert.equal((await c.query(`select public.verify_staff_pin($1, '9090') is not null ok`, [id])).rows[0].ok, true);
    for (const [sql, msg] of [[`select public.admin_add_person('X Example', 'boughshed-kitchen', 'staff', '12')`, /4-digit PIN/],
      [`select public.admin_add_person('Y Example', 'boughshed-kitchen', 'manager')`, /email/],
      [`select public.admin_add_person('Test Person Example', 'boughshed-kitchen', 'staff', '1234')`, /already exists/],
      [`select public.admin_add_person('Z Example', 'nowhere', 'staff', '1234')`, /No outlet/]]) {
      await c.query('savepoint s');
      await assert.rejects(c.query(sql), msg); await c.query('rollback to savepoint s');
    }
    const m = (await c.query(`select public.admin_add_person('Manager Example', 'boughshed-kitchen', 'manager', p_email => 'New.Manager@Example.com') id`)).rows[0].id;
    assert.equal((await c.query('select email from staff where id = $1', [m])).rows[0].email, 'new.manager@example.com');
  } finally { await c.query('rollback'); c.release(); }
  const t = await login('A-M1', 'manager-9999');
  for (const fn of ['admin_add_person', 'admin_set_pin', 'admin_add_to_outlet']) {
    await assert.rejects(t.rpc(fn, { p_name: 'Hack', p_outlet: 'boughshed-kitchen', p_pin: '0000' }), (e) => [401, 403, 404].includes(e.status), fn);
  }
});
