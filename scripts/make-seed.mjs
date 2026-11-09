// Generates supabase/seed.sql: EXAMPLE DATA for 4 outlets / ~60 staff / 6 finished weeks + today.
// Job library: mock-job-library-v2.md (food safety reading logs left out by request). Outlet sizes: v4 example.
// All dates are relative to "today in Perth" so the seed always looks current. Deterministic.
import { writeFileSync, mkdirSync } from 'node:fs';

let seed = 20261102;
const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const q = (v) => v === null || v === undefined ? 'null' : typeof v === 'number' || typeof v === 'boolean' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
const WEEKS = 6;                                   // finished weeks of history
const day = (n) => `(public.perth_today() - ${n})`;
// Never in the future: today's later shifts are clamped to "just now" so example ticks/approvals are realistic
const ts = (n, hhmm) => `least(((public.perth_today() - ${n}) + time '${hhmm}') at time zone 'Australia/Perth', now() - interval '2 minutes')`;
const wk = (n) => `(public.perth_week_start() - ${7 * n})`;
const S = (code) => `(select id from public.staff where staff_code = ${q(code)})`;
const O = (slug) => `(select id from public.outlets where slug = ${q(slug)})`;
const SEC = (slug) => slug ? `(select id from public.sections where slug = ${q(slug)})` : 'null';
// Today is day 0; days back to the Monday WEEKS weeks ago. JS needs today's ISO weekday (Perth) to align weeks.
const perthNow = new Date(Date.now() + 8 * 3600e3); const isoDow = ((perthNow.getUTCDay() + 6) % 7) + 1;
const DAYS_BACK = (isoDow - 1) + 7 * WEEKS;        // e.g. Monday -> 42
const weekOf = (d) => Math.floor((d - (isoDow - 1) + 6) / 7);  // 0 = this week, 1 = last week ...

const out = [`-- =====================================================================
-- Kitchen Quest seed: EXAMPLE DATA ONLY. Not Ivan's real outlets, staff, jobs, hours or rewards.
-- Example PINs: owner 2468, managers 9999, staff 1234. Change before real use.
-- Outlet names are real: 1 Boughshed Kitchen (pilot, live), 2 Monkey Bar Kitchen, 3 Monkey Bar, 4 Boughshed Bar (2-4 switched off).
-- Staff, jobs, hours, points and messages are EXAMPLE DATA.
-- Minimum hours to be ranked: 10 h per week (Ivan's setting), configurable per outlet by the owner.
-- =====================================================================`];

// Outlet names are Ivan's (real); staff, jobs, hours and activity are EXAMPLE DATA.
// Only Boughshed Kitchen (pilot) is switched on; the others are set up and ready to switch on in rollout order.
// [slug, name, sections, managers, crew, active, type]
const outlets = [
  ['boughshed-kitchen', 'Boughshed Kitchen', ['prep', 'line', 'pastry', 'dish'], 2, 22, true, 'kitchen'],
  ['monkey-bar-kitchen', 'Monkey Bar Kitchen', ['prep', 'line', 'pastry', 'dish'], 1, 17, false, 'kitchen'],
  ['monkey-bar', 'Monkey Bar', ['bar', 'barback'], 1, 11, false, 'bar'],
  ['boughshed-bar', 'Boughshed Bar', ['bar', 'barback'], 1, 5, false, 'bar'],
];
const LETTER = { 'boughshed-kitchen': 'A', 'monkey-bar-kitchen': 'B', 'monkey-bar': 'C', 'boughshed-bar': 'D' };
const typeOf = (slug) => outlets.find(o => o[0] === slug)[6];
const isActive = (slug) => outlets.find(o => o[0] === slug)[5];
out.push(`insert into public.outlets (slug, name, rollout_order, is_active, activated_at) values\n` +
  outlets.map((o, i) => `  (${q(o[0])}, ${q(o[1])}, ${i + 1}, ${o[5]}, ${o[5] ? day(DAYS_BACK) : 'null'})`).join(',\n') + ';');
out.push(`insert into public.sections (slug, name, colour, sort_order) values
  ('prep', 'Prep', '#2f7d4f', 1), ('line', 'Line', '#c2410c', 2), ('pastry', 'Pastry', '#a21caf', 3), ('dish', 'Dish', '#1d4ed8', 4),
  ('bar', 'Bar', '#b45309', 5), ('barback', 'Bar back', '#0f766e', 6);`);
out.push(`-- Ranking settings: 10 h/week minimum to be ranked (Ivan's setting) for the group board and all 4 outlets
insert into public.outlet_settings (outlet_id, min_hours_to_rank) values
  (null, 10.0)${outlets.map(o => `, (${O(o[0])}, 10.0)`).join('')};`);

// Names (made up)
const first = ['Jack','Mia','Lachlan','Aroha','Ella','Tom','Grace','Kai','Zoe','Liam','Hana','Isabella','Noah','Chloe','Daniel','Ruby','Josh','Maya',
  'Oliver','Charlotte','William','Amelia','Henry','Olivia','Lucas','Ava','Mason','Sienna','Ethan','Isla','Leo','Harper','Archie','Willow','Hugo',
  'Matilda','Finn','Ivy','Oscar','Evie','Jasper','Frankie','Raf','Jess','Sam','Priya','Ari','Tama','Mei','Ravi','Nina','Ben','Lily','Max','Rosa',
  'Felix','Tilly','Omar','Ana','Theo'];
const last = ['Morrison','Chen','Brooks','Wiremu','Fitzgerald','Nguyen',"O'Connor",'Patel','Williams','Kowalski','Sato','Rossi','Anderson','Martin',
  'Okafor','Singh','Tran','Harris','Kelly','Murphy','Walker','Ng','Papadopoulos','Lee','Hughes','Novak','Ali','Russo','Campbell','Park'];
let ni = 0; const nextName = () => { const n = `${first[ni % first.length]} ${last[(ni * 7 + 3) % last.length]}`; ni++; return n; };

const people = [];   // {code, name, role, section, lead, startedAgo, outlets:[slug], home}
people.push({ code: 'OWNER', name: 'Ivan Haynes (Owner)', role: 'owner', section: null, lead: false, startedAgo: 1500, outlets: [] });
outlets.forEach(([slug, , secs, mgrs, crew, , type], oi) => {
  const L = LETTER[slug]; const bar = type === 'bar';
  for (let m = 0; m < mgrs; m++) people.push({ code: `${L}-M${m + 1}`, name: nextName() + (bar ? (m === 0 ? ' (Bar Manager)' : ' (Asst Bar Manager)') : (m === 0 ? ' (Head Chef)' : ' (Sous Chef)')), role: 'manager',
    section: bar ? 'bar' : m === 0 ? 'line' : 'prep', lead: false, startedAgo: 800, outlets: [slug] });
  for (let i = 0; i < crew; i++) {
    const sec = secs[i % secs.length];
    people.push({ code: `${L}-${String(i + 1).padStart(2, '0')}`, name: nextName(), role: 'staff', section: sec, lead: i < 2 + oi % 2,
      startedAgo: i >= crew - 2 ? 10 + i : 60 + Math.floor(rnd() * 900), outlets: [slug] });
  }
});
// Six people also work at a second outlet
const dual = [['A-05', 'monkey-bar-kitchen'], ['A-09', 'monkey-bar-kitchen'], ['B-03', 'boughshed-kitchen'], ['B-08', 'boughshed-kitchen'], ['C-02', 'boughshed-bar'], ['D-01', 'monkey-bar']];
for (const [code, o] of dual) people.find(p => p.code === code).outlets.push(o);

// Managers and the owner sign in with email + password (Supabase Auth); staff tap name + PIN on the outlet tablet.
const emailOf = (p) => p.role === 'staff' ? null : p.role === 'owner' ? 'ivan.owner@example.com'
  : p.name.replace(/\(.*\)/, '').trim().toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).join('.') + '@example.com';
out.push(`insert into public.staff (staff_code, name, role, email, section_id, started_on, pin_hash) values\n` + people.map(p =>
  `  (${q(p.code)}, ${q(p.name)}, ${q(p.role)}, ${q(emailOf(p))}, ${SEC(p.section)}, ${day(p.startedAgo)}, extensions.crypt(${q(p.role === 'owner' ? '2468' : p.role === 'manager' ? '9999' : '1234')}, extensions.gen_salt('bf', 6)))`).join(',\n') + ';');
// Outlet tablet codes (EXAMPLE): a manager sets each tablet up once; staff then tap name + PIN
out.push(`insert into public.outlet_tablets (outlet_id, code) values\n` + outlets.map(o => `  (${O(o[0])}, 'EXAMPLE-${LETTER[o[0]]}')`).join(',\n') + ';');
// Shift leads are per outlet (staff_outlets.is_lead): every outlet gets 2-3 leads at their home outlet
out.push(`insert into public.staff_outlets (staff_id, outlet_id, is_home, is_lead) values\n` +
  people.flatMap(p => p.outlets.map((o, i) => `  (${S(p.code)}, ${O(o)}, ${i === 0}, ${p.lead && i === 0})`)).join(',\n') + ';');
for (const [slug] of outlets) if (!people.some(p => p.lead && p.outlets[0] === slug)) throw new Error('no lead at ' + slug);

// Job library v2 (no reading logs): [title, kind, section, shift, freq, pts, verify, grim, cap, weekday]
const J = [
  ['Hand basins stocked (soap, towels)', 'opening', null, 'am', 'daily', 5, 'self_tick'],
  ['Equipment on and checked, faults reported', 'opening', 'line', 'am', 'daily', 5, 'self_tick'],
  ["Read and confirm previous shift's handover", 'handover', null, null, 'per_shift', 5, 'self_tick'],
  ['Complete prep list for a station', 'prep', 'prep', 'am', 'per_shift', 10, 'manager'],
  ['Label and date all new containers', 'prep', null, null, 'per_shift', 5, 'manager'],
  ['FIFO rotate cool room shelves', 'prep', 'prep', 'am', 'daily', 10, 'manager'],
  ['Batch sauces and stocks', 'prep', 'prep', 'am', 'as_needed', 10, 'manager'],
  ['Portion and vac-pack proteins', 'prep', 'prep', 'am', 'as_needed', 10, 'self_tick'],
  ['Pastry mise: doughs, creams, garnishes', 'prep', 'pastry', 'am', 'daily', 10, 'self_tick'],
  ['Bake-off for service', 'prep', 'pastry', 'am', 'daily', 10, 'self_tick'],
  ['Restock station mid-service', 'service', 'line', 'pm', 'per_shift', 5, 'self_tick', false, 3],
  ['Keep pass clean and wiped', 'service', 'line', 'pm', 'per_shift', 5, 'self_tick'],
  ['Dish pit cleared after the rush', 'service', 'dish', 'pm', 'per_shift', 10, 'manager'],
  ['Allergen check before service', 'service', 'line', 'pm', 'per_shift', 5, 'manager'],
  ['Clean and sanitise all benches', 'closing', null, 'close', 'daily', 10, 'manager'],
  ['Clean flat-top/grill', 'closing', 'line', 'close', 'daily', 10, 'manager'],
  ['Filter fryer oil', 'closing', 'line', 'close', 'daily', 10, 'self_tick'],
  ['Wrap, label, store all leftovers', 'closing', null, 'close', 'daily', 5, 'manager'],
  ['Sweep and mop section floor', 'closing', null, 'close', 'daily', 10, 'manager'],
  ['Empty and clean bins', 'closing', null, 'close', 'daily', 15, 'manager', true],
  ['Dishwasher drained, filters cleaned', 'closing', 'dish', 'close', 'daily', 10, 'manager'],
  ['Pastry equipment cleaned', 'closing', 'pastry', 'close', 'daily', 10, 'manager'],
  ['Write shift handover', 'handover', null, 'close', 'per_shift', 10, 'manager'],
  ['Degrease canopy filters', 'deep_clean', 'line', null, 'weekly', 20, 'manager', false, null, 1],
  ['Boil out and deep clean fryers', 'deep_clean', 'line', null, 'weekly', 30, 'manager', false, null, 2],
  ['Pull out and clean behind equipment', 'deep_clean', 'line', null, 'fortnightly', 45, 'manager', true, null, 3],
  ['Scrub drains and floor grates', 'deep_clean', 'dish', null, 'weekly', 30, 'manager', true, null, 4],
  ['Deep clean cool room', 'deep_clean', 'prep', null, 'weekly', 30, 'manager', false, null, 5],
  ['Descale dishwasher', 'deep_clean', 'dish', null, 'weekly', 20, 'manager', false, null, 6],
  ['Clean oven/combi interior', 'deep_clean', 'pastry', null, 'weekly', 20, 'manager', false, null, 7],
];
// EXAMPLE bar job library (same point scale: 5 quick / 10 standard / 20 big / 30 deep, +50% grim)
const JB = [
  ['Cut garnishes (citrus, herbs) for service', 'opening', 'bar', 'pm', 'daily', 5, 'self_tick'],
  ['Fill ice wells', 'opening', 'barback', 'pm', 'per_shift', 5, 'self_tick'],
  ["Read and confirm previous shift's handover", 'handover', null, null, 'per_shift', 5, 'self_tick'],
  ['Bar back restock: spirits, mixers, fridges', 'service', 'barback', 'pm', 'per_shift', 10, 'manager'],
  ['Restock straws, napkins and coasters', 'service', 'bar', 'pm', 'per_shift', 5, 'self_tick', false, 3],
  ['Glass washing: clear the rack, polish and stock glassware', 'service', 'barback', 'pm', 'per_shift', 10, 'manager'],
  ['Change kegs and gas, faults reported', 'service', 'barback', 'pm', 'as_needed', 5, 'self_tick'],
  ['Glass washer drained, filters and arms cleaned', 'closing', 'barback', 'close', 'daily', 10, 'manager'],
  ['Wipe speed rails, bottles and back bar', 'closing', 'bar', 'close', 'daily', 5, 'self_tick'],
  ['Clean drip trays, bar mats and taps', 'closing', 'bar', 'close', 'daily', 10, 'manager'],
  ['Empty and clean bins and bottle bins', 'closing', null, 'close', 'daily', 15, 'manager', true],
  ['Mop behind the bar', 'closing', null, 'close', 'daily', 10, 'manager'],
  ['Write shift handover', 'handover', null, 'close', 'per_shift', 10, 'manager'],
  ['Clean beer lines', 'deep_clean', 'barback', null, 'weekly', 30, 'manager', false, null, 1],
  ['Deep clean ice machine', 'deep_clean', 'barback', null, 'weekly', 20, 'manager', false, null, 3],
  ['Scrub floor drains behind the bar', 'deep_clean', 'bar', null, 'weekly', 30, 'manager', true, null, 5],
  ['Clean and reorganise the cool room / cellar', 'deep_clean', 'barback', null, 'fortnightly', 30, 'manager', false, null, 2],
];
const libFor = (slug) => typeOf(slug) === 'bar' ? JB : J;
const descs = { self_tick: 'Tick it when done. A manager gives it a quick check and approves it.', manager: 'Tick it when done. A manager inspects it and approves it.' };
const jobRows = [];
for (const [slug, , secs] of outlets) {
  const mgr = `${LETTER[slug]}-M1`;
  for (const [t, k, sec, sh, f, p, v, grim = false, cap = null, wd = null] of libFor(slug)) {
    if (sec && !secs.includes(sec)) continue;
    jobRows.push(`  (${O(slug)}, ${q(t)}, ${q((grim ? 'Grim job: 50% bonus already included. ' : '') + descs[v])}, ${q(k)}, ${SEC(sec)}, ${q(sh)}, ${p}, ${grim}, ${q(f)}, ${q(wd)}, ${q(v)}, ${q(cap)}, ${S(mgr)})`);
  }
}
out.push(`insert into public.jobs (outlet_id, title, description, kind, section_id, shift, points, is_grim, recurrence, recur_weekday, verification, daily_cap, created_by) values\n` + jobRows.join(',\n') + ';');

// Roster, hours, assignments, completions
const SHIFT_HRS = { am: 7.5, pm: 6, close: 8 };
const times = { am: '09:30', pm: '15:00', close: '22:15' };
const roster = [], assigns = [], hours = new Map(); // key code|outlet|week -> {h, leave}
const crew = people.filter(p => p.role !== 'owner');   // staff, shift leads and managers all work shifts and compete
const leaveWeeks = new Set(); crew.forEach(p => { if (rnd() < 0.12) leaveWeeks.add(`${p.code}|${1 + Math.floor(rnd() * WEEKS)}`); });
const casual = new Set(crew.filter(() => rnd() < 0.15).map(p => p.code));   // often under the minimum
const effort = Object.fromEntries(crew.map(p => [p.code, 0.55 + rnd() * 0.45]));
// Three EXAMPLE high performers at the pilot outlet, so the top-3 streak board has multi-week runs to show
const stars = new Set(crew.filter(p => p.outlets[0] === 'boughshed-kitchen' && !casual.has(p.code)).slice(2, 5).map(p => p.code));
stars.forEach(c => effort[c] = 1);
for (const p of crew) for (let w = 0; w <= WEEKS; w++) if (leaveWeeks.has(`${p.code}|${w}`) && isActive(p.outlets[0]))
  hours.set(`${p.code}|${p.outlets[0]}|${w}`, { h: 0, leave: true });
for (let d = DAYS_BACK; d >= 0; d--) {
  const w = weekOf(d);
  for (const p of crew) {
    if (leaveWeeks.has(`${p.code}|${w}`) && !stars.has(p.code)) continue;
    if (!p.outlets.some(isActive)) continue;                              // outlet not live yet
    if (rnd() < (casual.has(p.code) ? 0.75 : 0.32)) continue;           // day off
    const live = p.outlets.filter(isActive);
    const o = live.length > 1 && rnd() < 0.35 ? live[1] : live[0];
    const shift = p.section === 'pastry' ? 'am' : ['dish', 'bar', 'barback'].includes(p.section) ? pick(['pm', 'close']) : pick(['am', 'pm', 'close']);
    roster.push(`  (${O(o)}, ${S(p.code)}, ${day(d)}, ${q(shift)})`);
    const k = `${p.code}|${o}|${w}`; const cur = hours.get(k) || { h: 0, leave: false };
    cur.h += SHIFT_HRS[shift] + (rnd() < 0.3 ? 0.5 : 0); hours.set(k, cur);
    const secs = outlets.find(x => x[0] === o)[2];
    const options = libFor(o).filter(j => (j[2] === p.section || j[2] === null) && (!j[2] || secs.includes(j[2])) && (j[3] === shift || j[3] === null) && !['deep_clean', 'handover'].includes(j[1]));
    const used = new Set(); const n = Math.min(options.length, stars.has(p.code) ? 4 : 2 + Math.floor(rnd() * 3));
    for (let i = 0; i < n; i++) { let j; do { j = pick(options); } while (used.has(j[0])); used.add(j[0]); assigns.push({ p, o, j, d, shift }); }
  }
  for (const [slug, , secs] of outlets.filter(o => o[5])) for (const j of libFor(slug).filter(x => x[1] === 'deep_clean' && secs.includes(x[2]))) {
    if (rnd() > 0.28) continue;
    const cands = crew.filter(c => c.outlets.includes(slug) && (c.section === j[2] || c.section === 'dish' || rnd() < 0.2));
    if (cands.length) assigns.push({ p: pick(cands), o: slug, j, d, shift: null });
  }
}
out.push(`insert into public.roster_shifts (outlet_id, staff_id, shift_date, shift) values\n` + roster.join(',\n') + '\non conflict do nothing;');

const mgrsOf = (slug) => people.filter(p => p.role === 'manager' && p.outlets.includes(slug)).map(p => p.code);
const aRows = [], cRows = []; let ai = 0, latePending = 0;
for (const a of assigns) {
  ai++; const aid = `'00000000-0000-4000-a000-${String(ai).padStart(12, '0')}'`;
  const rvs = mgrsOf(a.o).filter(c => c !== a.p.code); const rv = rvs.length ? pick(rvs) : 'OWNER';   // never your own job
  aRows.push(`  (${aid}, (select id from public.jobs where outlet_id = ${O(a.o)} and title = ${q(a.j[0])}), ${S(a.p.code)}, ${day(a.d)}, ${q(a.shift)}, ${S(rv)})`);
  const r = rnd(); const e = effort[a.p.code];
  let status = null;
  if (a.d === 0) status = r < 0.5 ? 'pending' : r < 0.62 ? 'approved' : null;
  else if (a.d <= 1) status = r < 0.55 * e + 0.25 ? (rnd() < 0.7 ? 'approved' : 'pending') : r < 0.9 ? 'rejected' : null;
  else status = r < 0.8 * e + 0.15 ? 'approved' : r < 0.93 ? 'rejected' : null;
  // EXAMPLE: two inspected-job tick-offs from 2 weeks ago that never got signed off. That week is now signed off, so
  // approving them credits the points to the current week (see ledger_set_weeks) and the queue shows a note.
  if (weekOf(a.d) === 2 && a.o === 'boughshed-kitchen' && a.j[6] === 'manager' && latePending < 2) { status = 'pending'; latePending++; }
  if (!status) continue;
  const t = times[a.shift || 'pm'];
  const reviewed = status !== 'pending';
  cRows.push(`  (${aid}, ${S(a.p.code)}, ${q(rnd() < 0.15 ? 'All done, chef' : null)}, ${q(status)}, ${ts(a.d, t)}, ${reviewed ? S(rv) : 'null'}, ${reviewed ? `least(${ts(a.d, t)} + interval '40 minutes', now() - interval '1 minute')` : 'null'}, ${q(status === 'rejected' ? pick(['Corners missed, please redo', 'Not done to standard, please redo', 'Not finished, bins still full']) : null)})`);
}
for (let i = 0; i < aRows.length; i += 1000) out.push(`insert into public.assignments (id, job_id, staff_id, due_date, shift, assigned_by) values\n` + aRows.slice(i, i + 1000).join(',\n') + '\non conflict do nothing;');
for (let i = 0; i < cRows.length; i += 1000) out.push(`insert into public.completions (assignment_id, staff_id, note, status, completed_at, reviewed_by, reviewed_at, review_note) values\n` + cRows.slice(i, i + 1000).join(',\n') + ';');

// Hours for finished weeks (this week left blank so the entry screen shows "Copy last week")
const hRows = [], missingDemo = [];
for (const [k, v] of hours) {
  const [code, o, w] = k.split('|'); if (Number(w) === 0) continue;
  // EXAMPLE: last week's hours not yet entered for two people, so the crown sign-off screen shows what's missing
  if (Number(w) === 1 && o === 'boughshed-kitchen' && !v.leave && !stars.has(code) && people.find(x => x.code === code).role === 'staff' && missingDemo.length < 2) { missingDemo.push(code); continue; }
  const owner = people.find(p => p.code === code);
  hRows.push(`  (${S(code)}, ${O(o)}, ${wk(Number(w))}, ${v.h.toFixed(2)}, ${q(v.leave ? 'approved_leave' : 'none')}, ${q(rnd() < 0.3 ? 'csv' : 'manual')}, ${S(mgrsOf(o)[0])})`);
}
out.push(`-- Weekly hours (EXAMPLE). Some are under the 10 h minimum or on approved leave, so they are unranked.
insert into public.weekly_hours (staff_id, outlet_id, week_start, hours, leave_status, source, entered_by) values\n` + hRows.join(',\n') + ';');
out.push(`-- Example pilot season (EXAMPLE DATA): ${WEEKS} weeks in of 12. Owner-only; length must be 10-12 weeks (CHECK).
-- Season Champion needs to be ranked in 60% of weeks (example, v7), i.e. 8 of 12.
insert into public.seasons (name, starts_on, length_weeks, min_ranked_pct, set_by)
values ('Pilot season (EXAMPLE)', ${wk(WEEKS)}, 12, 60, ${S('OWNER')});`);

// Reversal (failed spot check) and rush bonus
out.push(`insert into public.points_ledger (staff_id, outlet_id, entry_type, points, reason, completion_id, reverses_id, awarded_by, awarded_at)
select l.staff_id, l.outlet_id, 'reversal', -l.points, 'Reversed: spot check failed, back on the list', l.completion_id, l.id, ${S('A-M2')}, l.awarded_at + interval '1 hour'
  from public.points_ledger l where l.entry_type = 'award' and l.outlet_id = ${O('boughshed-kitchen')} and l.awarded_at < public.perth_today() - 9 order by l.id limit 2;
insert into public.points_ledger (staff_id, outlet_id, entry_type, points, reason, awarded_by, awarded_at)
select r.staff_id, r.outlet_id, 'bonus', 10, 'Rush bonus: slammed Saturday service, close-down passed', ${S('A-M1')}, ${ts(9, '23:00')}
  from public.roster_shifts r where r.outlet_id = ${O('boughshed-kitchen')} and r.shift_date = ${day(9)} and r.shift in ('pm', 'close');`);

// Weekly reward text (free text per week, per outlet + group)
const rw = [['Golden Spatula + first pick of next week\'s station', 'Trophy on the pass all week.'], ['Coffee shout for a week', 'Any coffee from across the road, Mon–Fri.'],
  ['Pick the staff meal theme', null], ['Dessert of your choice from pastry', null], ['First pick of roster swap', 'Check against the award before swapping hours.']];
const rRows = [];
for (let w = 0; w <= 3; w++) {
  outlets.filter(o => o[5]).forEach(([slug], i) => { const [t, d] = rw[(w + i) % rw.length]; rRows.push(`  (${O(slug)}, ${wk(w)}, ${q(t)}, ${q(d)}, ${S(`${LETTER[slug]}-M1`)})`); });
  rRows.push(`  (null, ${wk(w)}, ${q(w === 0 ? 'Group Champion: $30 voucher + crown on the group board' : 'Group Champion: $25 voucher')}, ${q('Set by Ivan. EXAMPLE.')}, ${S('OWNER')})`);
}
out.push(`insert into public.weekly_rewards (outlet_id, week_start, title, details, set_by) values\n` + rRows.join(',\n') + ';');

// Badges
out.push(`insert into public.badges (slug, name, description, icon) values
  ('hot-streak', 'Hot Streak', 'Top 3 two weeks running', '🔥'), ('on-fire', 'On Fire', 'Top 3 four weeks running', '🔥🔥'),
  ('unstoppable', 'Unstoppable', 'Top 3 eight weeks running', '🚀'), ('legend', 'Legend', 'Top 3 twelve weeks running', '👑'),
  ('deep-diver', 'Deep Diver', '5 verified deep cleans', '🤿'), ('fryer-whisperer', 'Fryer Whisperer', '10 fryer filters or boil-outs', '🍟'),
  ('mentor', 'Mentor', 'Buddied a new starter through their first week', '🤝'), ('no-shortcuts', 'No Shortcuts', 'A month with no points reversed', '✅'),
  ('handover-hero', 'Handover Hero', '10 handovers written and confirmed in a row', '📋');
insert into public.staff_badges (staff_id, badge_id, awarded_by)
select s.id, b.id, ${S('A-M1')} from public.staff s, public.badges b
 where (s.staff_code, b.slug) in (('A-01','fryer-whisperer'), ('A-04','deep-diver'), ('A-02','mentor'), ('A-06','handover-hero'), ('A-08','no-shortcuts'));`);

// Handovers
out.push(`insert into public.handovers (outlet_id, shift_date, shift, written_by, prep_notes, equipment_faults, customer_issues, deliveries, staffing, is_weekend_gap, confirmed_by, confirmed_at, created_at) values
  (${O('boughshed-kitchen')}, ${day(1)}, 'close', ${S('A-01')}, 'Veal jus made (dated yesterday). Need 2 more trays of focaccia.', 'Fryer 2 thermostat sticking, reported.', 'Table 12 nut allergy follow-up done.', 'Fish 7:30 am.', 'One sick call for AM, covered.', true, ${S('A-02')}, ${ts(0, '07:05')}, ${ts(1, '22:40')}),
  (${O('boughshed-kitchen')}, ${day(0)}, 'am', ${S('A-02')}, 'Prep list 80% done. Pickled onions carried over (dated today).', 'None.', 'None.', 'Dry goods 2 pm.', 'Full crew for PM.', false, null, null, ${ts(0, '14:20')}),
  (${O('boughshed-kitchen')}, ${day(2)}, 'pm', ${S('A-03')}, 'Desserts portioned for close.', 'Ice machine slow, filter ordered.', 'None.', 'None.', 'None.', false, ${S('A-04')}, ${ts(2, '17:10')}, ${ts(2, '16:50')});`);

// Messaging
out.push(`insert into public.channels (kind, outlet_id, name, is_everyone, created_by) values
  ('group', null, 'All outlets', true, ${S('OWNER')})${outlets.map(([slug, name]) => `,\n  ('group', ${O(slug)}, ${q(name + ' – whole kitchen')}, true, ${S(`${LETTER[slug]}-M1`)})`).join('')},
  ('direct', null, null, false, ${S('A-M1')});
insert into public.channel_members (channel_id, staff_id)
select (select id from public.channels where kind = 'direct'), id from public.staff where staff_code in ('A-M1', 'A-03');
insert into public.messages (channel_id, sender_id, body, is_memo, pinned, created_at) values
  ((select id from public.channels where name = 'All outlets'), ${S('OWNER')}, 'EXAMPLE MEMO: Leaderboards rank on points per hour worked, so part-timers can win. Minimum 10 h a week to be ranked. Done properly beats done fast.', true, true, ${ts(6, '08:00')}),
  ((select id from public.channels where name = 'All outlets'), ${S('OWNER')}, 'EXAMPLE MEMO: Tick a job when it is done. It earns points once a manager approves it. If a job turns out not to be done, the points are reversed. No photos, location or audio are collected.', true, true, ${ts(13, '09:00')}),
  ((select id from public.channels where outlet_id = ${O('boughshed-kitchen')} and is_everyone), ${S('A-M1')}, 'This week''s incentive: clear a grim job (bins, drains, behind the equipment) and the coffee''s on me.', true, true, ${ts(0, '08:00')}),
  ((select id from public.channels where outlet_id = ${O('boughshed-kitchen')} and is_everyone), ${S('A-01')}, 'Who borrowed the big chinois? Line needs it back by 5', false, false, ${ts(0, '13:10')}),
  ((select id from public.channels where outlet_id = ${O('boughshed-kitchen')} and is_everyone), ${S('A-03')}, 'Spare brioche on the pastry rack for staff meal 🥐', false, false, ${ts(0, '13:45')}),
  ((select id from public.channels where kind = 'direct'), ${S('A-M1')}, 'Great job on the cool room yesterday, looked spotless.', false, false, ${ts(0, '10:30')}),
  ((select id from public.channels where kind = 'direct'), ${S('A-03')}, 'Thanks chef!', false, false, ${ts(0, '10:34')});
insert into public.message_reads (message_id, staff_id)
select m.id, so.staff_id from public.messages m join public.channels c on c.id = m.channel_id
  join public.staff_outlets so on (c.outlet_id is null or so.outlet_id = c.outlet_id)
 where m.is_memo and (abs(hashtext(so.staff_id::text || m.id::text)) % 10) < 7
on conflict do nothing;`);

out.push(`-- Crowns: pending for every finished week; Ivan (owner) has signed off all but last week (EXAMPLE),
-- including one override. Signing off locks that week's hours.
select public.crown_weekly_winners();
update public.weekly_crowns c set status = 'confirmed', confirmed_by = ${S('OWNER')}, confirmed_at = c.crowned_at
 where c.week_start < public.perth_week_start() - 7;
update public.weekly_crowns c set winner_id = x.staff_id, overridden = true, override_by = ${S('OWNER')},
       override_reason = 'EXAMPLE: covered three extra closes for a sick teammate'
  from public.weekly_board x
 where x.outlet_id = c.outlet_id and x.week_start = c.week_start and x.position = 2
   and c.outlet_id = ${O('boughshed-kitchen')} and c.week_start = public.perth_week_start() - 21;`);
out.push(`-- How the other outlets switch on (owner only), in rollout order. Monkey Bar Kitchen is next:
--   select public.set_outlet_active((select id from public.outlets where slug = 'monkey-bar-kitchen'), true);
-- or tap "Switch on" in the admin portal (Outlets screen).`);

mkdirSync('supabase', { recursive: true });
writeFileSync('supabase/seed.sql', out.join('\n\n') + '\n');

// Go-live setup (real, no example people): Ivan's 4 outlets (all switched OFF until he switches one on), sections,
// the 10 h ranking minimum and badges. Staff, jobs and hours are entered for real after go-live.
const real = out.filter(x => /^(-- Ranking settings[^\n]*\n)?insert into public\.(outlets|sections|outlet_settings|badges) /.test(x))
  .map(x => x.startsWith('insert into public.outlets') ? x.replace(/, true, \(public\.perth_today\(\) - \d+\)\)/g, ', false, null)') : x)
  .map(x => x.split('\ninsert into public.staff_badges')[0]);   // badge list only, no example awards
writeFileSync('supabase/setup-go-live.sql', `-- Kitchen Quest go-live setup (REAL outlets, no example people). Run once in the Supabase SQL editor
-- INSTEAD of seed.sql. Then: select public.bootstrap_owner('Ivan Haynes', '<your email>'); and add people with
-- public.admin_add_person(...) (see supabase/migrations/20261102000006_admin_helpers.sql).
` + real.join('\n\n') + '\n');

console.log(`seed: ${people.length} people, ${roster.length} shifts, ${aRows.length} assignments, ${cRows.length} completions, ${hRows.length} hours rows`);
