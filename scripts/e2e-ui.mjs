// End-to-end UI check through the real screens (tap name + PIN, tick, approve, reject, reverse). EXAMPLE DATA.
// KQ_URL=https://<quick-tunnel>.trycloudflare.com node scripts/e2e-ui.mjs   (default http://localhost:8787)
// Screenshots: screenshots/${KQ_SHOT_PREFIX:-e2e}-*.png
import { chromium } from 'playwright-core';
import pg from 'pg';
const BASE = process.env.KQ_URL || 'http://localhost:8787', PFX = process.env.KQ_SHOT_PREFIX || 'e2e';
const pool = new pg.Pool({ connectionString: 'postgres://postgres:postgres@localhost:54329/kitchen_quest' });
const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
const log = (...a) => console.log('✔', ...a); const fail = (m) => { console.error('✖', m); process.exitCode = 1; };
const check = (c, m) => c ? log(m) : fail(m);
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const shot = (page, n) => page.screenshot({ path: `screenshots/${PFX}-${n}.png`, fullPage: false });

const TABLET = { outlet_id: 1, outlet: 'Boughshed Kitchen', code: 'EXAMPLE-A' };
const newPage = async (tabletPreset) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block' });
  if (tabletPreset) await ctx.addInitScript(t => { if (!localStorage.kq_tablet) localStorage.kq_tablet = JSON.stringify(t); }, TABLET);
  const page = await ctx.newPage(); page.on('dialog', d => d.accept()); return { ctx, page }; };
// Managers/owner: email + password on the sign-in form
async function managerSession(email, password) {
  const s = await newPage(false); const p = s.page;
  await p.goto(BASE + '/#/login'); await p.fill('#em', email); await p.fill('#pw', password); await p.click('#ef button[type=submit]');
  await p.waitForSelector('nav.side', { state: 'attached', timeout: 15000 }); return s;
}
// Staff: on the outlet tablet, tap name + PIN (pin-login Edge Function)
async function session(name, pin) {
  const s = await newPage(true); const p = s.page;
  await p.goto(BASE + '/#/login'); await p.fill('#find', name.split(' ')[0]);
  await p.locator('.name', { hasText: name }).first().click();
  for (const k of pin) await p.click(`.pinpad button[data-k="${k}"]`);
  await p.waitForSelector('nav.side', { state: 'attached', timeout: 15000 }); return s;
}

// 0) a manager sets this device up as the Boughshed Kitchen tablet (real flow), then staff can tap their names
{ const m = await managerSession('jack.wiremu@example.com', 'manager-9999'); const p = m.page;
  await p.goto(BASE + '/#/tablet'); await p.waitForSelector('[data-set="1"]'); await shot(p, '00a-manager-tablet-setup');
  await p.click('[data-set="1"]'); await p.waitForSelector('.names .name', { timeout: 15000 }); await shot(p, '00b-tablet-tap-your-name');
  const t = JSON.parse(await p.evaluate(() => localStorage.kq_tablet)); check(t.code === TABLET.code && !(await p.evaluate(() => localStorage.kq_session)),
    'manager set up the tablet (email login) → signed out → staff names shown');
  await m.ctx.close(); }

// 1) staff: My jobs, tick one off (a non-lead staff member at Boughshed with an unticked job today; rosters change daily)
const STAFF = process.env.KQ_STAFF || (await one(`select s.name from assignments a join staff s on s.id = a.staff_id and s.role = 'staff'
  join jobs j on j.id = a.job_id and j.outlet_id = 1 where a.due_date = public.perth_today()
   and not exists (select 1 from completions c where c.assignment_id = a.id)
   and not exists (select 1 from staff_outlets x where x.staff_id = s.id and x.is_lead) group by s.name order by count(*) desc, s.name limit 1`)).name;
log('staff member for the test:', STAFF);
const ella = await session(STAFF, '1234'); let p = ella.page;
await p.waitForSelector('h1:has-text("My jobs")'); await shot(p, '01-staff-my-jobs');
const before = (await one(`select count(*)::int n from completions c join staff s on s.id = c.staff_id where s.name = $1`, [STAFF])).n;
await p.locator('.job label.btn').first().click(); await p.waitForTimeout(1500);
const tick = await one(`select c.id, c.status, j.title from completions c join staff s on s.id = c.staff_id join assignments a on a.id = c.assignment_id join jobs j on j.id = a.job_id
  where s.name = $1 order by c.completed_at desc limit 1`, [STAFF]);
check((await one(`select count(*)::int n from completions c join staff s on s.id = c.staff_id where s.name = $1`, [STAFF])).n === before + 1 && tick.status === 'pending',
  `staff ticked "${tick.title}" → pending`);
check((await one('select count(*)::int n from points_ledger where completion_id = $1', [tick.id])).n === 0, 'pending tick earns 0 points');
await p.locator('.job', { hasText: tick.title }).first().scrollIntoViewIfNeeded(); await shot(p, '02-staff-ticked-waiting');
check(await p.locator('.job', { hasText: tick.title }).locator('text=Waiting for sign-off').count() > 0, 'staff sees "Waiting for sign-off"');

// 2) leaderboard
await p.locator('a[href="#/board"]:visible').first().click(); await p.waitForSelector('table, .podium, h1'); await p.waitForTimeout(800); await shot(p, '03-leaderboard');
check(/points|pts|\/h/i.test(await p.locator('#main').innerText()), 'leaderboard renders points per hour');

// 3) shift lead: approves the staff member's tick; has Approvals but no Jobs tab; own ticks not in queue
const lead = await session('Lachlan Harris', '1234'); p = lead.page;
check(await p.locator('nav.side a[href="#/approvals"]').count() === 1 && await p.locator('nav.side a[href="#/jobs"]').count() === 0, 'lead has Approvals tab, no Jobs editor');
await p.goto(BASE + '/#/approvals'); await p.waitForSelector('h1:has-text("Approvals")'); await p.waitForTimeout(800);
check(!(await p.locator('.appr', { hasText: 'Lachlan Harris' }).count()), "lead's own ticks are not in the lead's queue");
await p.locator(`.appr[data-id="${tick.id}"]`).scrollIntoViewIfNeeded().catch(() => {}); await shot(p, '04-lead-approvals-queue');
await p.locator(`.appr[data-id="${tick.id}"] [data-ok]`).click(); await p.waitForTimeout(1200);
const ap = await one(`select c.status, r.name rv, (select sum(points)::int from points_ledger where completion_id = c.id) pts from completions c join staff r on r.id = c.reviewed_by where c.id = $1`, [tick.id]);
check(ap.status === 'approved' && ap.rv === 'Lachlan Harris' && ap.pts > 0, `lead approved → +${ap.pts} to ${STAFF}, approved by ${ap.rv}`);
check((await one(`select count(*)::int n from points_ledger l join staff s on s.id = l.staff_id where l.completion_id = $1 and s.name = 'Lachlan Harris'`, [tick.id])).n === 0, 'lead earned nothing for approving');
await shot(p, '05-lead-after-approve');

// 4) manager: reject one pending, reverse that approved one
const mgr = await managerSession('jack.wiremu@example.com', 'manager-9999'); p = mgr.page;
await p.goto(BASE + '/#/approvals'); await p.waitForSelector('h1:has-text("Approvals")'); await p.waitForTimeout(800); await shot(p, '06-manager-approvals');
const rej = p.locator('.appr').first(); const rejId = await rej.getAttribute('data-id');
await rej.locator('[data-no]').click(); await p.fill('#rsn', 'Bench still greasy, please redo'); await shot(p, '07-manager-reject-reason');
await p.click('#rok'); await p.waitForTimeout(1200);
const rj = await one(`select status, review_note, (select count(*)::int from points_ledger where completion_id = $1) n from completions where id = $1`, [rejId]);
check(rj.status === 'rejected' && rj.n === 0 && /greasy/.test(rj.review_note), 'manager rejected a tick with a reason → 0 points');
await p.reload(); await p.waitForSelector('[data-reverse]', { timeout: 20000 });
if (!(await p.locator(`[data-reverse="${tick.id}"]`).count())) console.log('listed:', await p.locator('[data-reverse]').evaluateAll(b => b.map(x => x.dataset.reverse).slice(0, 5)), 'want', tick.id);
const rev = p.locator(`[data-reverse="${tick.id}"]`); await rev.scrollIntoViewIfNeeded(); await shot(p, '08-manager-recently-approved');
await rev.click(); await p.fill('#rsn', 'Spot check: not actually done'); await shot(p, '09-manager-reverse-reason'); await p.click('#rok'); await p.waitForTimeout(1200);
const rv = await one(`select c.status, (select sum(points)::int from points_ledger where completion_id = c.id) net,
  (select reason from points_ledger where completion_id = c.id and entry_type = 'reversal' order by id desc limit 1) why,
  (select count(*)::int from audit_log where row_id = c.id::text and new_data->>'status' = 'reversed') aud from completions c where c.id = $1`, [tick.id]);
check(rv.status === 'reversed' && rv.net === 0 && /not actually done/.test(rv.why) && rv.aud >= 1, `manager reversed → net 0, reason "${rv.why}", audit-logged`);
await shot(p, '10-manager-after-reverse');

// 5) staff sees the outcome
p = ella.page; await p.goto(BASE + '/#/my'); await p.waitForTimeout(1200);
await p.locator('.job', { hasText: tick.title }).first().scrollIntoViewIfNeeded(); await shot(p, '11-staff-sees-reversed');
check(await p.locator('.job', { hasText: tick.title }).locator('text=Points reversed').count() > 0, 'staff sees "Points reversed"');

await browser.close(); await pool.end();
console.log(process.exitCode ? 'SOME CHECKS FAILED' : `ALL UI CHECKS PASSED via ${BASE}`);
