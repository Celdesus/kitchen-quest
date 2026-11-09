// Headless screenshots at phone (390x844) and tablet (1024x768). Needs the server running.
import { chromium } from 'playwright-core';
import pg from 'pg';
import { mkdirSync, readFileSync } from 'node:fs';

const BASE = process.env.KQ_URL || 'http://localhost:8787';
const OUT = new URL('../screenshots/', import.meta.url).pathname; mkdirSync(OUT, { recursive: true });
const pool = new pg.Pool({ host: 'localhost', port: 54329, user: 'postgres', password: 'postgres', database: 'kitchen_quest' });
import { createClient } from '../public/kq-api.js';
const ANON = JSON.parse((await (await fetch(`${BASE}/config.js`)).text()).match(/= (\{.*\});/)[1]).anonKey;
const TABLET = { outlet_id: 1, outlet: 'Boughshed Kitchen', code: 'EXAMPLE-A' };   // example tablet code (seed)
const signIn = async (fn) => { let s = null; const c = createClient({ url: BASE, anonKey: ANON, store: { get: () => s, set: (v) => s = v } }); await fn(c); return s; };
const staffCode = (await pool.query(`select s.staff_code from staff s join assignments a on a.staff_id = s.id and a.due_date = public.perth_today()
    join staff_outlets so on so.staff_id = s.id and so.outlet_id = 1 where s.role = 'staff' group by s.staff_code order by count(*) desc limit 1`)).rows[0].staff_code;
const staffId = (await pool.query('select id from staff where staff_code = $1', [staffCode])).rows[0].id;
const tokens = { owner: await signIn(c => c.signInWithPassword('ivan.owner@example.com', 'owner-2468')),
  manager: await signIn(c => c.signInWithPassword('jack.wiremu@example.com', 'manager-9999')),
  staff: await signIn(c => c.signInWithPin({ staff_id: staffId, pin: '1234', ...TABLET, tablet_code: TABLET.code })) };
const thisWeek = (await pool.query(`select public.perth_week_start()::text w`)).rows[0].w;
await pool.end();

const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });

// App icons (PNG) from the SVG
{ const p = await browser.newPage({ viewport: { width: 512, height: 512 } }); const svg = readFileSync(new URL('../public/icons/icon.svg', import.meta.url), 'utf8');
  for (const n of [512, 192]) { await p.setViewportSize({ width: n, height: n }); await p.setContent(`<body style="margin:0">${svg.replace('<svg ', `<svg width="${n}" height="${n}" `)}</body>`);
    await p.screenshot({ path: new URL(`../public/icons/icon-${n}.png`, import.meta.url).pathname, omitBackground: true }); } await p.close(); }

const shots = [
  ['01-leaderboard-group', 'owner', '#/board?o=group'],
  ['02-leaderboard-boughshed-manager', 'manager', '#/board?o=1'],
  ['03-crown-signoff-owner', 'owner', '#/crowns'],
  ['04-hours-entry-owner', 'owner', '#/hours?o=1'],
  ['04b-hours-this-week-not-open', 'owner', '#/hours?o=1&w=__THISWEEK__'],
  ['05-hours-csv-preview', 'owner', '#/hours?o=1&demoCsv=1', async (p) => { await p.fill('#csvt', 'A-01, 38\nA-02, 22.5\nA-07, 0, leave\nNobody Real, 10'); await p.dispatchEvent('#csvt', 'input'); }],
  ['06-jobs-editor', 'manager', '#/jobs?o=1'],
  ['07-job-edit-dialog', 'manager', '#/jobs?o=1&demoEdit=1'],
  ['08-approvals-queue', 'manager', '#/approvals?o=1'],
  ['09-weekly-reward', 'owner', '#/rewards'],
  ['10-messages', 'manager', '#/messages'],
  ['11-handovers', 'manager', '#/handovers?o=1'],
  ['12-outlets-rollout', 'owner', '#/outlets'],
  ['13-staff-my-jobs', 'staff', '#/my'],
  ['14-login-tap-name', 'tablet', '#/login'],
  ['14b-login-manager-email', null, '#/login'],
  ['15-tablet-setup', 'manager', '#/tablet'],
];
const sizes = { phone: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, tablet: { width: 1024, height: 768, deviceScaleFactor: 1 } };
const files = [];
for (const [size, vp] of Object.entries(sizes)) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch,
    deviceScaleFactor: vp.deviceScaleFactor, timezoneId: 'Australia/Perth', locale: 'en-AU', serviceWorkers: 'block' });
  for (const [name, who, hash, extra] of shots) {
    const page = await ctx.newPage();
    await page.goto(BASE + '/'); await page.evaluate(([t, o, tab]) => { localStorage.clear(); if (t) localStorage.kq_session = JSON.stringify(t);
      if (o) localStorage.kq_outlet = o; if (tab) localStorage.kq_tablet = JSON.stringify(tab); },
      [tokens[who] || null, '1', who === 'tablet' || who === 'staff' ? TABLET : null]);
    await page.goto(`${BASE}/${hash.replace('__THISWEEK__', thisWeek)}`); await page.reload(); await page.waitForLoadState('networkidle'); await page.waitForTimeout(400);
    if (extra) { await extra(page); await page.waitForTimeout(200); }
    const file = `${OUT}${name}-${size}.png`; await page.screenshot({ path: file, fullPage: false }); files.push(file); await page.close();
  }
  await ctx.close();
}
await browser.close();
console.log(files.join('\n'));
