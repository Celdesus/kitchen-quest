// Kitchen Quest PWA (prototype, EXAMPLE DATA). Vanilla JS, no build step: fast on an old kitchen tablet.
// Talks straight to Supabase (kq-api.js): data via SQL RPC functions under RLS, staff PIN login via the
// pin-login Edge Function, managers/owner via email + password. Settings come from /config.js (written at deploy).
import { createClient } from './kq-api.js';
const CFG = window.KQ_CONFIG || {};
if (!CFG.exampleData) document.querySelector('.example-banner')?.remove();   // shown only for example/demo data
const sessionStore = { get: () => { try { return JSON.parse(localStorage.kq_session || 'null'); } catch { return null; } },
  set: (v) => v ? localStorage.kq_session = JSON.stringify(v) : localStorage.removeItem('kq_session') };
const SB = createClient({ url: CFG.supabaseUrl || '', anonKey: CFG.anonKey || '', store: sessionStore });
const tablet = { get: () => { try { return JSON.parse(localStorage.kq_tablet || 'null'); } catch { return null; } },
  set: (v) => v ? localStorage.kq_tablet = JSON.stringify(v) : localStorage.removeItem('kq_tablet') };
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = { token: sessionStore.get()?.access_token || null, me: null, outlet: localStorage.kq_outlet || null };
const fmtDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
const fmtTime = (t) => new Date(t).toLocaleString('en-AU', { timeZone: 'Australia/Perth', weekday: 'short', hour: 'numeric', minute: '2-digit' });
const fmtLong = (t) => new Date(t).toLocaleString('en-AU', { timeZone: 'Australia/Perth', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const weekLabel = (w) => `${fmtDate(w)} – ${fmtDate(addDays(w, 6))}`;
const isMgr = () => ['manager', 'owner'].includes(S.me?.user.role);
const isOwner = () => S.me?.user.role === 'owner';

function toast(msg, ms = 2200) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(t._h); t._h = setTimeout(() => t.hidden = true, ms); }
async function api(path, opts = {}) {
  try { return await SB.api(path, { method: opts.method || 'GET', body: opts.body }); }
  catch (e) { if (e.status === 401 && S.token) { logout(); throw new Error('Please sign in again'); } throw e; }
}
function logout() { clearTimeout(idle); SB.signOut(); S.token = null; S.me = null; if (location.hash !== '#/login') location.hash = '#/login'; else route(); }
// Shared outlet tablet: a staff session signs itself out after 5 minutes without a tap.
let idle; const IDLE_MS = 5 * 60_000;
const armIdle = () => { clearTimeout(idle); if (tablet.get() && S.me?.user.role === 'staff') idle = setTimeout(() => { toast('Signed out (5 min idle)'); logout(); }, IDLE_MS); };
['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, armIdle, { passive: true }));

// ---------- layout ----------
const NAV = () => {
  const r = S.me.user.role;
  const items = r === 'staff'
    ? [['my', '✅', 'My jobs'], ['board', '🏆', 'Leaderboard'], ...(S.me.user.lead ? [['approvals', '✔️', 'Approvals']] : []), ['messages', '💬', 'Messages'], ...(S.me.user.lead ? [['handovers', '📋', 'Handover']] : [])]
    : [['board', '🏆', 'Leaderboard'], ...(r === 'manager' ? [['my', '✅', 'My jobs']] : []), ...(r === 'owner' ? [['crowns', '👑', 'Crown sign-off'], ['hours', '⏱️', 'Hours']] : []),
       ['approvals', '✔️', 'Approvals'], ['jobs', '🧽', 'Jobs'], ['rewards', '🎁', 'Weekly reward'], ['messages', '💬', 'Messages'],
       ['handovers', '📋', 'Handovers'], ...(r === 'owner' ? [['outlets', '🏢', 'Outlets']] : []), ['tablet', '📱', 'Tablet set-up']];
  return items;
};
function layout(page, html) {
  const nav = NAV();
  $('#app').innerHTML = `<div class="shell">
    <nav class="side"><div class="brand">👑 Kitchen Quest</div>
      ${nav.map(([k, i, l]) => `<a href="#/${k}" class="${k === page ? 'on' : ''}">${i} ${l}</a>`).join('')}
      <div class="who">${esc(S.me.user.name)}<br><span class="pill">${S.me.user.role}</span> <a href="#" id="logout" style="padding:0;display:inline;color:#93c5fd">Log out</a></div></nav>
    <main id="main">${html}</main>
    <nav class="bottom">${nav.slice(0, 6).map(([k, i, l]) => `<a href="#/${k}" class="${k === page ? 'on' : ''}"><span>${i}</span>${l}</a>`).join('')}</nav></div>`;
  $('#logout').onclick = (e) => { e.preventDefault(); logout(); };
}
const outletTabs = (current, { group = true, all = false, onlyActive = false } = {}) => {
  const list = S.me.outlets.filter(o => !onlyActive || o.is_active);
  return `<div class="tabs" id="otabs">${group ? `<button class="tab ${current === 'group' ? 'on' : ''}" data-o="group">🌏 Group-wide</button>` : ''}
    ${all ? `<button class="tab ${current === 'all' ? 'on' : ''}" data-o="all">All outlets</button>` : ''}
    ${list.map(o => `<button class="tab ${String(o.id) === String(current) ? 'on' : ''} ${o.is_active ? '' : 'off'}" data-o="${o.id}">${esc(o.name)}${o.is_active ? '' : ' · off'}</button>`).join('')}</div>`;
};
const bindTabs = (id, fn) => document.querySelectorAll(`#${id} .tab`).forEach(b => b.onclick = () => fn(b.dataset.o ?? b.dataset.w));
const defaultOutlet = () => S.outlet && S.me.outlets.some(o => String(o.id) === S.outlet) ? S.outlet : String((S.me.outlets.find(o => o.is_active) || S.me.outlets[0])?.id ?? 'group');

// ---------- login: tap name, then PIN ----------
async function viewLogin() {
  const t = tablet.get();
  if (!t) return viewEmailLogin('This device isn\'t set up as an outlet tablet yet. Managers: sign in, then use 📱 Tablet set-up so staff can tap their name + PIN here.');
  let roster = null; try { roster = await SB.roster(t.outlet_id, t.code); } catch (e) { toast(e.message); }
  if (!roster) return viewEmailLogin(`This tablet's code for ${t.outlet} no longer works (or the outlet is switched off). A manager needs to set it up again.`);
  $('#app').innerHTML = `<div class="login"><h1>👑 Kitchen Quest</h1><p class="muted">${esc(t.outlet)} tablet · tap your name, then enter your PIN.</p>
    <input type="text" id="find" placeholder="Search names…" style="max-width:320px;margin-bottom:12px">
    <div class="names" id="names"></div>
    <p style="margin-top:18px"><a href="#" id="mgr" class="small">Manager or owner? Sign in with email</a></p></div>`;
  const draw = (f = '') => { $('#names').innerHTML = roster.filter(p => p.name.toLowerCase().includes(f.toLowerCase())).map(p =>
    `<button class="name" data-id="${p.id}">${esc(p.name)}<div class="small muted">${esc(p.section || '')}</div></button>`).join('');
    document.querySelectorAll('.name').forEach(b => b.onclick = () => pinPad(roster.find(p => p.id === b.dataset.id), t)); };
  draw(); $('#find').oninput = (e) => draw(e.target.value);
  $('#mgr').onclick = (e) => { e.preventDefault(); viewEmailLogin(); };
}
function viewEmailLogin(note = '') {
  const t = tablet.get();
  $('#app').innerHTML = `<div class="login"><h1>👑 Kitchen Quest</h1><p class="muted">Managers and owner: sign in with your email and password.</p>
    ${note ? `<p class="small muted">${esc(note)}</p>` : ''}
    <form id="ef" style="max-width:340px;display:grid;gap:10px"><input type="email" id="em" placeholder="Email" autocomplete="username" required>
      <input type="password" id="pw" placeholder="Password" autocomplete="current-password" required>
      <button class="btn primary" type="submit">Sign in</button></form>
    ${t ? '<p style="margin-top:16px"><a href="#" id="back" class="small">← Back to staff names</a></p>' : ''}</div>`;
  $('#ef').onsubmit = async (e) => { e.preventDefault();
    try { await SB.signInWithPassword($('#em').value.trim(), $('#pw').value); S.token = sessionStore.get()?.access_token; S.me = null; location.hash = '#/board'; route(); }
    catch (err) { toast(err.message); } };
  if (t) $('#back').onclick = (e) => { e.preventDefault(); viewLogin(); };
}
function pinPad(person, t) {
  let pin = '';
  $('#app').innerHTML = `<div class="login" style="text-align:center"><h1>Hi ${esc(person.name.split(' ')[0])} 👋</h1><p class="muted">Enter your PIN</p>
    <div class="dots" id="dots">${'<i></i>'.repeat(4)}</div>
    <div class="pinpad">${[1, 2, 3, 4, 5, 6, 7, 8, 9, '←', 0, '✓'].map(k => `<button data-k="${k}">${k}</button>`).join('')}</div>
    <p><button class="btn ghost" id="back">Not you?</button></p></div>`;
  const dots = () => $('#dots').innerHTML = [0, 1, 2, 3].map(i => `<i class="${i < pin.length ? 'f' : ''}"></i>`).join('');
  let busy = false;
  const submit = async () => { if (busy) return; busy = true;
    try { await SB.signInWithPin({ staff_id: person.id, pin, outlet_id: t.outlet_id, tablet_code: t.code });
      S.token = sessionStore.get()?.access_token; S.me = null; location.hash = '#/my'; route(); }
    catch (e) { toast(e.message); pin = ''; dots(); } finally { busy = false; } };
  document.querySelectorAll('.pinpad button').forEach(b => b.onclick = () => { const k = b.dataset.k;
    if (k === '←') pin = pin.slice(0, -1); else if (k === '✓') return submit(); else if (pin.length < 6) pin += k;
    dots(); if (pin.length === 4) submit(); });
  $('#back').onclick = () => viewLogin();
}
// Managers/owner: make this device the tablet for one of their outlets (staff then log in by name + PIN).
async function viewTablet() {
  const mine = S.me.outlets.filter(o => o.manages && o.is_active); const t = tablet.get();
  layout('tablet', `<h1>📱 Tablet set-up</h1>
    <p class="small muted">Do this once on each kitchen tablet. Staff then tap their name and PIN; nobody can see names or try PINs without this tablet's code.
    You'll be signed out so the tablet is ready for staff.</p>
    ${t ? `<div class="card" style="margin-bottom:12px">This device is the <b>${esc(t.outlet)}</b> tablet. <button class="btn sm ghost" id="unset">Stop using as a tablet</button></div>` : ''}
    <div class="cards">${mine.map(o => `<div class="card"><h3>${esc(o.name)}</h3><div class="row" style="gap:8px;flex-wrap:wrap">
      <button class="btn primary sm" data-set="${o.id}">Use this device as the ${esc(o.name)} tablet</button>
      <button class="btn ghost sm" data-new="${o.id}">New code (old tablets must be set up again)</button></div></div>`).join('') || '<p class="muted">No switched-on outlets that you manage.</p>'}</div>`);
  document.querySelectorAll('[data-set],[data-new]').forEach(b => b.onclick = async () => {
    const id = Number(b.dataset.set || b.dataset.new); if (b.dataset.new && !confirm('Make a new code? Every tablet for this outlet will need setting up again.')) return;
    try { const r = await api('/api/tablet', { method: 'POST', body: { outlet_id: id, new_code: !!b.dataset.new } });
      tablet.set({ outlet_id: r.outlet_id, outlet: r.outlet, code: r.code }); toast(`Tablet ready for ${r.outlet}`); logout(); } catch (e) { toast(e.message); } });
  if (t) $('#unset').onclick = () => { tablet.set(null); toast('This device is no longer a tablet'); viewTablet(); };
}

// ---------- leaderboard (polished) ----------
async function viewBoard(params) {
  const o = params.o || (isOwner() ? 'group' : defaultOutlet());
  let week = params.w || S.me.week_start;
  let data = await api(`/api/board?outlet=${o}&week=${week}`); let note = '';
  if (!params.w && !data.rows.some(r => r.ranked)) { week = S.me.last_week; data = await api(`/api/board?outlet=${o}&week=${week}`);
    note = `No hours entered for this week yet, so this is last week's board (crowned at Monday 00:00 AWST).`; }
  const season = (await api('/api/seasons')).current;
  const ranked = data.rows.filter(r => r.ranked); const unranked = data.rows.filter(r => !r.ranked && (r.points > 0 || r.hours > 0 || r.on_leave));
  const top = ranked.slice(0, 3); const maxP = Math.max(...ranked.map(r => r.points_per_hour || 0), 1);
  const finished = week < S.me.week_start; const scopeName = o === 'group' ? 'Group-wide board' : S.me.outlets.find(x => String(x.id) === String(o))?.name;
  const weeks = [S.me.week_start, S.me.last_week, addDays(S.me.last_week, -7), addDays(S.me.last_week, -14)];
  const crown = data.crown; const minH = data.setting?.min_hours_to_rank ?? 15;
  const crownCard = !finished
    ? `<div class="crown pending"><div class="row"><div class="em">👑</div><div class="grow"><div class="big">Crown up for grabs</div>
        <div class="muted">Week ends Sunday 23:59 AWST. The top points-per-hour is crowned Monday 00:00, then Ivan signs it off.</div></div></div></div>`
    : !crown ? `<div class="crown pending"><div class="big">No crown for this week</div><div class="muted">Nobody reached the minimum hours.</div></div>`
    : `<div class="crown ${crown.status === 'pending' ? 'pending' : ''}"><div class="row"><div class="em">👑</div><div class="grow">
        <div class="small muted">${crown.status === 'pending' ? 'PENDING SIGN-OFF' : 'CROWNED'} · ${esc(scopeName)}</div>
        <div class="big">${esc(crown.winner_name)}</div>
        <div>${crown.points_per_hour ?? '–'} pts/hr${crown.overridden ? ` · <span class="pill amber">Override by ${esc(crown.override_by_name)}</span> <span class="small muted">“${esc(crown.override_reason)}” (system pick: ${esc(crown.auto_name)})</span>` : ''}</div>
        ${crown.status === 'pending' ? `<div class="small muted">${isOwner() ? 'Check the board, then approve or override.' : 'Awaiting Ivan’s sign-off. Only the owner can approve or override.'}</div>`
          : `<div class="small muted">Signed off by ${esc(crown.confirmed_by_name)} · hours for this week are locked</div>`}</div>
        ${isOwner() && crown.status === 'pending' ? `<div class="row"><button class="btn gold" id="approve">Approve</button><button class="btn ghost" id="override">Override…</button></div>` : ''}
        ${isOwner() && crown.status === 'confirmed' ? `<button class="btn ghost sm" id="override">Change winner…</button>` : ''}</div></div>`;
  layout('board', `
    <div class="row"><h1 class="grow">🏆 ${esc(scopeName)}</h1>${season ? `<span class="pill blue">${esc(season.name)} · week ${season.current_week} of ${season.length_weeks}</span>` : ''}</div>
    ${outletTabs(o)}
    <div class="tabs" id="wtabs" style="margin-top:6px">${weeks.map((w, i) => `<button class="tab ${w === week ? 'on' : ''}" data-w="${w}">${i === 0 ? 'This week (live)' : i === 1 ? 'Last week' : weekLabel(w)}</button>`).join('')}</div>
    ${note ? `<p class="small muted">ℹ️ ${note}</p>` : ''}
    <div class="grid2" style="margin-top:12px">
      <div>
        <div class="hero"><div class="reward"><div class="gift">🎁</div><div class="grow"><div class="small" style="color:#bbf7d0">REWARD · ${weekLabel(week)}</div>
          <b>${esc(data.reward?.title || 'No reward set for this week yet')}</b><span class="small" style="color:#d1fae5">${esc(data.reward?.details || '')}</span></div></div></div>
        <div style="margin-top:12px">${crownCard}</div>
        ${top.length ? `<div class="podium">${[top[1], top[0], top[2]].map((r, i) => r ? `<div class="pod p${r.position}">
          <div class="medal">${['🥈', '🥇', '🥉'][i]}</div><div class="nm">${esc(r.name)}</div><div class="pph">${r.points_per_hour}</div>
          <div class="small muted">pts/hr · ${r.points} pts · ${r.hours} h</div></div>` : '<div></div>').join('')}</div>` : ''}
        <div class="card" style="margin-top:12px"><div class="row"><h3 class="grow">Rankings · points per hour worked</h3><span class="small muted">Min ${minH} h to rank</span></div>
          <div class="tablewrap"><table><thead><tr><th>#</th><th>Name</th><th class="hide-sm" style="width:30%"></th><th class="num">Pts/hr</th><th class="num">Points</th><th class="num">Hours</th></tr></thead><tbody>
          ${ranked.map(r => `<tr><td><span class="rank ${r.position <= 3 ? 'r' + r.position : ''}">${r.position}</span></td>
            <td><b>${esc(r.name)}</b>${r.is_rookie ? ' <span class="pill blue">Rookie</span>' : ''}<div class="small muted">${esc(r.section || '')}${o === 'group' ? '' : ''}</div></td>
            <td class="hide-sm"><div class="bar"><i style="width:${Math.round(100 * (r.points_per_hour || 0) / maxP)}%"></i></div></td>
            <td class="num"><b>${r.points_per_hour}</b></td><td class="num">${r.points}</td><td class="num">${r.hours}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Nobody ranked yet this week.</td></tr>'}
          </tbody></table></div>
          ${unranked.length ? `<h3 style="margin-top:14px">Not ranked this week <span class="small muted">(points still count; streaks pause)</span></h3>
            <div class="tablewrap"><table><tbody>${unranked.map(r => `<tr><td>${esc(r.name)}</td><td class="small muted">${esc(r.unranked_reason)}</td><td class="num">${r.points} pts</td><td class="num">${r.hours} h</td></tr>`).join('')}</tbody></table></div>` : ''}
        </div>
      </div>
      <div>
        <div class="card"><h3>🔥 Top-3 streaks</h3><div class="small muted" style="margin-bottom:6px">Weeks in a row finishing top 3. Leave or under-minimum weeks pause a streak, they don't break it.</div>
          ${data.streaks.map(s => `<div class="streak"><div class="flame">🔥</div><div class="n">${s.current_streak}</div><div class="grow"><b>${esc(s.name)}</b>
            <div class="small muted">${s.current_streak} week${s.current_streak > 1 ? 's' : ''}${s.milestone ? ` · ${esc(s.milestone)} badge` : ''}</div>
            ${s.paused_last_week ? '<div class="paused">⏸ paused last week (leave / under minimum)</div>' : ''}</div></div>`).join('') || '<p class="muted">No streaks yet.</p>'}</div>
        <div class="card" style="margin-top:12px"><h3>Sections this week</h3>
          ${data.sections.map(s => `<div class="row" style="padding:6px 0"><span class="pill" style="background:${s.colour}">${esc(s.section)}</span><span class="grow"></span><b>${s.points_per_hour ?? '–'}</b><span class="small muted">pts/hr</span></div>`).join('') || '<p class="muted small">No hours entered yet.</p>'}</div>
        ${data.pending != null ? `<div class="card" style="margin-top:12px"><div class="row"><div class="grow"><b>${data.pending}</b> tick-offs waiting for sign-off</div><a class="btn sm primary" href="#/approvals" style="text-decoration:none;display:inline-grid;place-items:center">Review</a></div></div>` : ''}
        <p class="small muted" style="margin-top:12px">Ranked on points per hour so part-timers can win. Group board = total points ÷ total hours across outlets. Ties: more verified jobs, then more deep cleans.</p>
      </div>
    </div>`);
  bindTabs('otabs', (v) => { if (v !== 'group') S.outlet = localStorage.kq_outlet = v; go('board', { o: v, w: params.w }); });
  bindTabs('wtabs', (w) => go('board', { o, w }));
  if ($('#approve')) $('#approve').onclick = async () => { try { if (!await confirmCrown(o, week)) return; toast('Crown approved. Hours for this week are now locked.'); viewBoard({ o, w: week }); } catch (e) { toast(e.message); } };
  if ($('#override')) $('#override').onclick = () => overrideDialog(o, week, ranked, () => viewBoard({ o, w: week }));
}
function overrideDialog(o, week, ranked, done) {
  const d = document.createElement('dialog');
  d.innerHTML = `<h3>Override winner · ${weekLabel(week)}</h3><label>New winner</label><select id="ow">${ranked.map(r => `<option value="${r.staff_id}">#${r.position} ${esc(r.name)} (${r.points_per_hour} pts/hr)</option>`).join('')}</select>
    <label style="margin-top:10px">Reason (saved in the audit log)</label><input type="text" id="or" placeholder="e.g. covered extra closes for a sick teammate">
    <div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn ghost" value="cancel">Cancel</button><button class="btn gold" id="ook">Override and sign off</button></div>`;
  document.body.append(d); d.showModal(); d.querySelector('[value=cancel]').onclick = () => d.remove();
  d.querySelector('#ook').onclick = async () => { try { await api('/api/crowns/override', { method: 'POST', body: { outlet_id: o, week_start: week, winner_id: $('#ow', d).value, reason: $('#or', d).value } });
    d.remove(); toast('Winner overridden and signed off'); done(); } catch (e) { toast(e.message); } };
}

// Crown readiness: what is still missing for this outlet/week. Shown before sign-off; warns, never blocks.
function readyBlock(r, scopeId, week) {
  if (!r) return '';
  if (r.all_clear) return `<div class="ready ok">✓ All hours entered · nothing waiting for approval${r.unranked_count ? ` · ${r.unranked_count} unranked` : ''}</div>`;
  const names = r.missing_hours.slice(0, 6).map(m => esc(m.name) + (scopeId === 'group' ? ` <span class="muted">(${esc(m.outlet)})</span>` : '')).join(', ') + (r.missing_hours_count > 6 ? ` +${r.missing_hours_count - 6} more` : '');
  return `<div class="ready warn"><b>⚠ Still missing for this week</b><ul>
    ${r.missing_hours_count ? `<li><b>${r.missing_hours_count}</b> staff with no hours entered: ${names} <a href="#/hours?o=${scopeId === 'group' ? 'all' : scopeId}&w=${week}">Enter hours →</a></li>` : ''}
    ${r.pending_count ? `<li><b>${r.pending_count}</b> tick-off${r.pending_count > 1 ? 's' : ''} still waiting for approval (approved after sign-off, they count in the open week) <a href="#/approvals?o=${scopeId}">Review →</a></li>` : ''}
    <li><b>${r.unranked_count}</b> unranked (under min hours, on leave or no hours) · ${r.ranked_count} ranked</li></ul></div>`;
}
function readyWarning(r) {
  if (!r || r.all_clear) return true;
  return confirm(`Still missing for this week:\n${r.missing_hours_count ? `• ${r.missing_hours_count} staff with no hours entered\n` : ''}${r.pending_count ? `• ${r.pending_count} tick-offs waiting for approval\n` : ''}• ${r.unranked_count} unranked\n\nSigning off locks this week's hours. Approve anyway?`);
}
async function confirmCrown(scopeId, week, readiness) {
  if (readiness === undefined) readiness = (await api(`/api/crowns?week=${week}`)).find(c => String(c.outlet_id ?? 'group') === String(scopeId))?.readiness;
  if (!readyWarning(readiness)) return false;
  await api('/api/crowns/confirm', { method: 'POST', body: { outlet_id: scopeId, week_start: week } }); return true;
}

// ---------- owner: Monday crown sign-off across all boards ----------
async function viewCrowns(params) {
  const week = params.w || S.me.last_week; const crowns = await api(`/api/crowns?week=${week}`);
  layout('crowns', `<h1>👑 Crown sign-off</h1><p class="muted">Week ${weekLabel(week)}. Winners were calculated at Monday 00:00 AWST. Only you (owner) can approve or override; signing off locks that week's hours.</p>
    <div class="tabs" id="wtabs">${[S.me.last_week, addDays(S.me.last_week, -7), addDays(S.me.last_week, -14)].map(w => `<button class="tab ${w === week ? 'on' : ''}" data-w="${w}">${weekLabel(w)}</button>`).join('')}</div>
    <div class="cards" style="margin-top:12px">${crowns.map(c => `<div class="crown ${c.status === 'pending' ? 'pending' : ''}"><div class="small muted">${esc(c.scope_name)}</div>
      <div class="big">👑 ${esc(c.winner_name)}</div><div>${c.points_per_hour} pts/hr · ${c.points} pts</div>
      ${c.overridden ? `<div class="small"><span class="pill amber">Overridden</span> system pick ${esc(c.auto_name)}</div>` : ''}
      ${c.status === 'pending' ? readyBlock(c.readiness, c.outlet_id ?? 'group', week) : ''}
      <div style="margin-top:10px">${c.status === 'pending' ? `<button class="btn gold sm" data-ok="${c.outlet_id ?? 'group'}">${c.readiness?.all_clear ? 'Approve' : 'Approve anyway…'}</button> <a class="btn ghost sm" href="#/board?o=${c.outlet_id ?? 'group'}&w=${week}" style="text-decoration:none">Review board</a>`
        : '<span class="pill green">Signed off · hours locked</span>'}</div></div>`).join('') || '<p class="muted">No crowns for this week.</p>'}</div>`);
  bindTabs('wtabs', (w) => go('crowns', { w }));
  document.querySelectorAll('[data-ok]').forEach(b => b.onclick = async () => { try { const c = crowns.find(x => String(x.outlet_id ?? 'group') === b.dataset.ok);
    if (!await confirmCrown(b.dataset.ok, week, c?.readiness)) return; toast('Approved'); viewCrowns({ w: week }); } catch (e) { toast(e.message); } });
}

// ---------- owner: weekly hours entry (fast grid) ----------
async function viewHours(params) {
  const o = params.o || defaultOutlet(); const week = params.w || S.me.last_week;
  const [data, settings] = await Promise.all([api(`/api/hours?outlet=${o}&week=${week}`), api('/api/settings')]);
  const rows = data.rows.map(r => ({ ...r, h: r.hours, l: r.leave_status || 'none', src: r.source || 'manual', dirty: false }));
  const notOpen = !data.entry_open;   // current week opens Sunday 18:00 AWST
  const locked = (r) => notOpen || data.group_locked || data.locked_outlets.includes(r.outlet_id);
  const allLocked = rows.length && rows.every(locked);
  const setting = settings.find(s => String(s.outlet_id) === String(o)) || settings.find(s => s.outlet_id == null);
  const weeks = [S.me.week_start, S.me.last_week, addDays(S.me.last_week, -7)];
  layout('hours', `<div class="row"><h1 class="grow">⏱️ Weekly hours</h1><span class="pill">Owner only</span></div>
    <p class="muted small">Type hours from the Deputy roster. <b>Tab</b> moves across, <b>Enter</b> moves down. Staff who work at two outlets appear once per outlet.</p>
    ${outletTabs(o, { group: false, all: true })}
    <div class="tabs" id="wtabs" style="margin-top:6px">${weeks.map((w, i) => `<button class="tab ${w === week ? 'on' : ''}" data-w="${w}">${i === 0 ? 'This week' : i === 1 ? 'Last week' : weekLabel(w)}</button>`).join('')}</div>
    ${notOpen ? `<div class="lock" style="margin-top:10px">⏰ Hours for ${weekLabel(week)} open on ${new Date(data.opens_at).toLocaleString('en-AU', { timeZone: 'Australia/Perth', weekday: 'long', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} AWST (your reminder is 9 pm). Winners calculate at Monday 00:00 AWST.</div>`
      : allLocked ? `<div class="lock" style="margin-top:10px">🔒 Locked: you signed off this week's winner, so these hours are read-only.</div>`
      : week === S.me.week_start ? `<div class="ready ok" style="margin-top:10px">🟢 This week's hours are open (from Sunday 18:00 AWST). Winners calculate at Monday 00:00 AWST.</div>` : ''}
    <div class="row" style="margin:12px 0">
      <button class="btn" id="copy" ${allLocked ? 'disabled' : ''}>⤵ Copy last week</button>
      <button class="btn" id="csv" ${allLocked ? 'disabled' : ''}>📋 Paste CSV</button>
      <span class="grow"></span>
      ${o !== 'all' && setting ? `<label style="margin:0">Min hours to rank</label><input type="number" id="minh" value="${setting.min_hours_to_rank}" step="0.5" style="width:90px">
        <span class="small muted">h/week</span>` : ''}
      <button class="btn primary" id="save" disabled>Save</button></div>
    <div class="card" style="padding:0;overflow-x:auto"><div class="tablewrap"><table class="hours"><thead><tr><th>Staff</th>${o === 'all' ? '<th>Outlet</th>' : ''}<th class="num hide-sm">Last week</th><th class="num">Hours</th><th>Leave</th><th class="hide-sm">Source</th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr data-i="${i}" class="${r.l === 'approved_leave' ? 'leave' : ''}"><td><b>${esc(r.name)}</b> <span class="small muted">${esc(r.staff_code)} · ${esc(r.section || '')}</span></td>
        ${o === 'all' ? `<td class="small">${esc(r.outlet)}</td>` : ''}
        <td class="num lw hide-sm">${r.last_week_leave === 'approved_leave' ? 'leave' : (r.last_week_hours ?? '–')}</td>
        <td class="num"><input type="text" class="h" data-i="${i}" inputmode="decimal" value="${r.h ?? ''}" placeholder="0" ${locked(r) ? 'disabled' : ''}></td>
        <td><select class="l" data-i="${i}" ${locked(r) ? 'disabled' : ''}><option value="none">Working</option><option value="approved_leave" ${r.l === 'approved_leave' ? 'selected' : ''}>Approved leave</option></select></td>
        <td class="small muted hide-sm src">${r.hours == null ? '' : esc(r.src)}</td></tr>`).join('')}</tbody></table></div></div>`);
  const dirtyCount = () => rows.filter(r => r.dirty).length;
  const refresh = () => { const n = dirtyCount(); $('#save').disabled = !n; $('#save').textContent = n ? `Save ${n} change${n > 1 ? 's' : ''}` : 'Save';
    document.querySelectorAll('.hours tbody tr').forEach(tr => { const r = rows[tr.dataset.i]; tr.classList.toggle('changed', r.dirty); tr.classList.toggle('leave', r.l === 'approved_leave'); }); };
  const set = (i, patch) => { Object.assign(rows[i], patch, { dirty: true }); };
  document.querySelectorAll('input.h').forEach(inp => {
    inp.oninput = () => { set(inp.dataset.i, { h: inp.value === '' ? null : Number(inp.value), src: rows[inp.dataset.i].src === 'csv' ? 'csv' : 'manual' }); refresh(); };
    inp.onfocus = () => inp.select();
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); const all = [...document.querySelectorAll('input.h:not([disabled])')]; const n = all[all.indexOf(inp) + (e.shiftKey ? -1 : 1)]; if (n) n.focus(); else $('#save').focus(); } };
  });
  document.querySelectorAll('select.l').forEach(sel => { sel.onchange = () => { set(sel.dataset.i, { l: sel.value, ...(sel.value === 'approved_leave' ? { h: 0 } : {}) });
    if (sel.value === 'approved_leave') document.querySelector(`input.h[data-i="${sel.dataset.i}"]`).value = 0; refresh(); };
    sel.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); const n = document.querySelector(`input.h[data-i="${Number(sel.dataset.i) + 1}"]`); if (n) n.focus(); } }; });
  $('#copy').onclick = () => { let n = 0; rows.forEach((r, i) => { if (locked(r) || r.last_week_hours == null) return; set(i, { h: r.last_week_hours, l: r.last_week_leave || 'none', src: 'manual' }); n++;
    document.querySelector(`input.h[data-i="${i}"]`).value = r.last_week_hours; document.querySelector(`select.l[data-i="${i}"]`).value = r.last_week_leave || 'none'; }); refresh(); toast(`Copied ${n} rows from last week. Check, then Save.`); };
  $('#csv').onclick = () => csvDialog(rows, o, (matches) => { matches.forEach(m => { set(m.i, { h: m.hours, l: m.leave, src: 'csv' });
    document.querySelector(`input.h[data-i="${m.i}"]`).value = m.hours; document.querySelector(`select.l[data-i="${m.i}"]`).value = m.leave; }); refresh(); toast(`${matches.length} rows filled from CSV. Check, then Save.`); });
  $('#save').onclick = async () => { try { const body = { week_start: week, rows: rows.filter(r => r.dirty).map(r => ({ staff_id: r.staff_id, outlet_id: r.outlet_id, hours: r.h ?? 0, leave_status: r.l, source: r.src })) };
    const res = await api('/api/hours', { method: 'PUT', body }); toast(`Saved ${res.saved} rows`); viewHours({ o, w: week }); } catch (e) { toast(e.message); } };
  if ($('#minh')) $('#minh').onchange = async (e) => { try { await api('/api/settings', { method: 'PUT', body: { outlet_id: o, min_hours_to_rank: Number(e.target.value) } }); toast('Minimum hours updated'); } catch (er) { toast(er.message); } };
  bindTabs('otabs', (v) => { if (v !== 'all') S.outlet = localStorage.kq_outlet = v; go('hours', { o: v, w: week }); });
  bindTabs('wtabs', (w) => go('hours', { o, w }));
  if (params.demoCsv) $('#csv').click();
}
function csvDialog(rows, o, apply) {
  const d = document.createElement('dialog'); d.style.maxWidth = '720px';
  d.innerHTML = `<h3>Paste hours (CSV)</h3><p class="small muted">One person per line: <code>name or staff code, hours</code>, optional third column <code>leave</code>. ${o === 'all' ? 'In All outlets, add the outlet name as a 4th column for people at two outlets.' : ''}</p>
    <textarea id="csvt" rows="6" placeholder="A-01, 38&#10;Sienna Anderson, 22.5&#10;A-07, 0, leave"></textarea>
    <div id="prev" style="margin-top:10px;max-height:260px;overflow:auto"></div>
    <div class="row" style="margin-top:12px;justify-content:flex-end"><button class="btn ghost" id="cx">Cancel</button><button class="btn primary" id="ap" disabled>Fill grid</button></div>`;
  document.body.append(d); d.showModal();
  let ok = [];
  const parse = () => { ok = []; const lines = $('#csvt', d).value.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const out = lines.map(line => { const [who, hrs, leave, outlet] = line.split(/[,\t]/).map(x => (x || '').trim());
      const key = who.toLowerCase(); let cands = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.staff_code.toLowerCase() === key || r.name.toLowerCase() === key);
      if (outlet) cands = cands.filter(({ r }) => r.outlet.toLowerCase().includes(outlet.toLowerCase()));
      const h = Number(hrs); const lv = /leave/i.test(leave || '') ? 'approved_leave' : 'none';
      let status = cands.length === 1 && (Number.isFinite(h) && h >= 0 && h <= 120) ? 'ok' : !cands.length ? 'No match' : cands.length > 1 ? 'Two outlets: add outlet column' : 'Bad hours';
      if (status === 'ok') ok.push({ i: cands[0].i, hours: lv === 'approved_leave' ? 0 : h, leave: lv });
      return `<tr><td>${esc(line)}</td><td>${cands.length === 1 ? esc(cands[0].r.name) : ''}</td><td class="num">${esc(hrs)}</td><td class="${status === 'ok' ? 'ok' : 'bad'}">${status === 'ok' ? '✓ ready' : '✕ ' + status}</td></tr>`; });
    $('#prev', d).innerHTML = lines.length ? `<div class="tablewrap"><table class="preview"><thead><tr><th>Line</th><th>Matched</th><th class="num">Hours</th><th>Preview</th></tr></thead><tbody>${out.join('')}</tbody></table></div>
      <p class="small muted">${ok.length} of ${lines.length} ready. Nothing is saved until you press Save.</p>` : '';
    $('#ap', d).disabled = !ok.length; };
  $('#csvt', d).oninput = parse; $('#cx', d).onclick = () => d.remove(); $('#ap', d).onclick = () => { apply(ok); d.remove(); };
  return d;
}

// ---------- jobs editor (managers of that outlet / owner) ----------
const KINDS = ['opening', 'prep', 'service', 'closing', 'cleaning', 'deep_clean', 'handover'];
const REC = ['one_off', 'per_shift', 'daily', 'weekly', 'fortnightly', 'monthly', 'as_needed'];
const VER = { self_tick: '✋ Quick check', manager: '👀 Lead or manager inspects' };
async function viewJobs(params) {
  const o = params.o || defaultOutlet(); const [jobs, staff] = await Promise.all([api(`/api/jobs?outlet=${o}`), api(`/api/staff?outlet=${o}`)]);
  layout('jobs', `<div class="row"><h1 class="grow">🧽 Jobs and points</h1><button class="btn primary" id="new">+ New job</button><button class="btn" id="assign">Assign</button></div>
    <p class="small muted">Only managers (for their outlet) and the owner can add, edit, delete or assign jobs. Every change is audit-logged. Scale: 5 quick · 10 standard · 20 big · 30 deep clean · +50% grim.</p>
    ${outletTabs(o, { group: false })}
    <div class="card" style="margin-top:10px;padding:0;overflow-x:auto"><div class="tablewrap"><table><thead><tr><th>Job</th><th class="hide-sm">Section</th><th class="hide-sm">Shift</th><th>How often</th><th>Check</th><th class="num">Points</th><th></th></tr></thead><tbody>
    ${jobs.map(j => `<tr style="${j.active ? '' : 'opacity:.5'}"><td><b>${esc(j.title)}</b>${j.is_grim ? ' <span class="pill amber">grim</span>' : ''}<div class="small muted">${esc(j.kind.replace('_', ' '))}${j.daily_cap ? ` · max ${j.daily_cap}/day` : ''}</div></td>
      <td class="hide-sm">${esc(j.section || 'All')}</td><td class="hide-sm">${esc(j.shift || 'Any')}</td><td>${esc(j.recurrence.replace('_', ' '))}${j.recur_weekday ? ' · ' + ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][j.recur_weekday] : ''}</td>
      <td class="small">${VER[j.verification]}</td><td class="num"><b style="font-size:18px;color:var(--gold)">${j.points}</b></td><td><button class="btn sm ghost" data-edit="${j.id}">Edit</button></td></tr>`).join('')}
    </tbody></table></div></div>`);
  bindTabs('otabs', (v) => { S.outlet = localStorage.kq_outlet = v; go('jobs', { o: v }); });
  $('#new').onclick = () => jobDialog(o, null, () => viewJobs({ o }));
  document.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => jobDialog(o, jobs.find(j => j.id === b.dataset.edit), () => viewJobs({ o })));
  $('#assign').onclick = () => assignDialog(jobs, staff);
  if (params.demoEdit && jobs[0]) jobDialog(o, jobs.find(j => j.verification === 'manager') || jobs[0], () => {});
}
function jobDialog(o, j, done) {
  const d = document.createElement('dialog'); const v = (k, def = '') => esc(j?.[k] ?? def);
  d.innerHTML = `<h3>${j ? 'Edit job' : 'New job'}</h3><div class="formgrid">
    <div class="full"><label>Title</label><input type="text" name="title" value="${v('title')}"></div>
    <div class="full"><label>How and why (plain language)</label><input type="text" name="description" value="${v('description')}"></div>
    <div><label>Type</label><select name="kind">${KINDS.map(k => `<option ${j?.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
    <div><label>Points</label><input type="number" name="points" value="${v('points', 10)}" min="0" max="1000"></div>
    <div><label>How often</label><select name="recurrence">${REC.map(k => `<option ${j?.recurrence === k ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
    <div><label>Weekday (weekly)</label><select name="recur_weekday"><option value="">–</option>${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((x, i) => `<option value="${i + 1}" ${j?.recur_weekday === i + 1 ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
    <div><label>Shift</label><select name="shift"><option value="">Any</option>${['am', 'pm', 'close'].map(x => `<option ${j?.shift === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
    <div><label>Check</label><select name="verification">${Object.entries(VER).map(([k, l]) => `<option value="${k}" ${j?.verification === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div><label>Max per day</label><input type="number" name="daily_cap" value="${v('daily_cap')}" min="1"></div>
    <div><label><input type="checkbox" name="is_grim" ${j?.is_grim ? 'checked' : ''}> Grim job</label><label><input type="checkbox" name="active" ${j?.active !== false ? 'checked' : ''}> Active</label></div></div>
    <div class="row" style="margin-top:14px">${j ? '<button class="btn danger" id="del">Delete</button>' : ''}<span class="grow"></span><button class="btn ghost" id="cx">Cancel</button><button class="btn primary" id="ok">Save</button></div>`;
  document.body.append(d); d.showModal(); $('#cx', d).onclick = () => d.remove();
  $('#ok', d).onclick = async () => { const f = Object.fromEntries([...d.querySelectorAll('[name]')].map(i => [i.name, i.type === 'checkbox' ? i.checked : i.value]));
    f.points = Number(f.points); f.daily_cap = f.daily_cap ? Number(f.daily_cap) : null; f.recur_weekday = f.recur_weekday ? Number(f.recur_weekday) : null;
    try { await api(j ? `/api/jobs/${j.id}` : '/api/jobs', { method: j ? 'PUT' : 'POST', body: { ...f, outlet_id: Number(o) } }); d.remove(); toast('Saved'); done(); } catch (e) { toast(e.message); } };
  if (j) $('#del', d).onclick = async () => { if (!confirm('Delete this job? Points already earned stay in the ledger.')) return; try { await api(`/api/jobs/${j.id}`, { method: 'DELETE' }); d.remove(); toast('Deleted'); done(); } catch (e) { toast(e.message); } };
}
function assignDialog(jobs, staff) {
  const d = document.createElement('dialog');
  d.innerHTML = `<h3>Assign a job</h3><label>Job</label><select id="aj">${jobs.filter(j => j.active).map(j => `<option value="${j.id}">${esc(j.title)} (${j.points})</option>`).join('')}</select>
    <label style="margin-top:8px">Person</label><select id="as">${staff.filter(s => s.role !== 'owner').map(s => `<option value="${s.id}">${esc(s.name)} · ${esc(s.section || '')}</option>`).join('')}</select>
    <div class="formgrid" style="margin-top:8px"><div><label>Date</label><input type="date" id="ad" value="${S.me.today}"></div><div><label>Shift</label><select id="ash"><option value="">Any</option><option>am</option><option>pm</option><option>close</option></select></div></div>
    <div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn ghost" id="cx">Cancel</button><button class="btn primary" id="ok">Assign</button></div>`;
  document.body.append(d); d.showModal(); $('#cx', d).onclick = () => d.remove();
  $('#ok', d).onclick = async () => { try { await api('/api/assignments', { method: 'POST', body: { job_id: $('#aj', d).value, staff_id: $('#as', d).value, due_date: $('#ad', d).value, shift: $('#ash', d).value } }); d.remove(); toast('Assigned'); } catch (e) { toast(e.message); } };
}

// ---------- approvals queue: approve / reject pending ticks; reverse approved points if the job wasn't done ----------
function reasonDialog(title, help, placeholder, okLabel, danger = true) {
  return new Promise(resolve => { const d = document.createElement('dialog');
    d.innerHTML = `<h3>${esc(title)}</h3><p class="small muted">${esc(help)}</p><input type="text" id="rsn" placeholder="${esc(placeholder)}">
      <div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn ghost" id="rx">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" id="rok" disabled>${esc(okLabel)}</button></div>`;
    document.body.append(d); d.showModal(); const inp = $('#rsn', d); inp.focus();
    inp.oninput = () => $('#rok', d).disabled = inp.value.trim().length < 3;
    $('#rx', d).onclick = () => { d.remove(); resolve(null); }; $('#rok', d).onclick = () => { const v = inp.value.trim(); d.remove(); resolve(v); }; });
}
async function viewApprovals(params) {
  const o = params.o || (isOwner() ? 'group' : defaultOutlet());
  const [items, done] = await Promise.all([api(`/api/approvals?outlet=${o}`), api(`/api/approved?outlet=${o}`)]);
  layout('approvals', `<div class="row"><h1 class="grow">✔️ Approvals</h1><span class="pill amber">${items.length} waiting</span></div>
    <p class="small muted">A ticked job earns nothing until you approve it. Reject it if it isn't done. If an approved job turns out not to have been done, reverse it: that takes the points back with your reason, and it's logged. Nobody approves, rejects or reverses their own tick (another lead, a manager or Ivan does), and approving earns you no points.</p>
    ${outletTabs(o, { group: isOwner() })}
    <h2>Waiting for approval</h2>
    <div class="cards" style="margin-top:10px">${items.slice(0, 40).map(c => `<div class="card appr" data-id="${c.id}">
      <div><div class="row"><b class="grow">${esc(c.title)}</b><span style="color:var(--gold);font-weight:900;font-size:20px">+${c.points}</span></div>
        <div class="small">${esc(c.staff_name)} · ${esc(c.outlet)} · <span class="muted">${VER[c.verification]}</span></div><div class="small muted">Ticked ${fmtLong(c.completed_at)}</div>
        ${c.note ? `<div class="small">“${esc(c.note)}”</div>` : ''}
        ${c.week_locked ? `<div class="latenote">⏩ Week of ${fmtDate(c.week_of)} is already signed off. Approving credits these points to this week (${weekLabel(c.open_week)}); the signed-off week won't change.</div>` : ''}
        <div class="row" style="margin-top:8px"><button class="btn primary sm" data-ok>✓ Approve</button><button class="btn danger sm" data-no>✕ Reject</button></div></div></div>`).join('') || '<p class="muted">All caught up 🎉</p>'}</div>
    <h2 style="margin-top:22px">Recently approved <span class="small muted">(last 14 days · reverse if it wasn't really done)</span></h2>
    <div class="card" style="padding:0"><div class="tablewrap"><table><tbody>${done.map(c => `<tr data-rev="${c.id}"><td><b>${esc(c.title)}</b><div class="small muted">${esc(c.staff_name)} · approved ${fmtLong(c.reviewed_at)}${c.approved_by ? ' by ' + esc(c.approved_by) : ''}</div></td>
      <td class="num" style="color:var(--gold);font-weight:800">+${c.points}</td><td class="num"><button class="btn sm ghost" data-reverse="${c.id}">↩ Reverse</button></td></tr>`).join('') || '<tr><td class="muted">Nothing approved in the last 14 days.</td></tr>'}</tbody></table></div></div>`);
  bindTabs('otabs', (v) => go('approvals', { o: v }));
  document.querySelectorAll('.appr').forEach(card => {
    const review = async (status) => { const note = status === 'rejected' ? await reasonDialog('Reject this tick', 'It goes back to them with your note and earns no points.', 'e.g. bins still full', 'Reject') : null; if (status === 'rejected' && note === null) return;
      try { await api(`/api/completions/${card.dataset.id}/review`, { method: 'POST', body: { status, review_note: note } }); card.remove(); toast(status === 'approved' ? (card.querySelector('.latenote') ? 'Approved: points credited to this week' : 'Approved, points awarded') : 'Sent back'); } catch (e) { toast(e.message); } };
    $('[data-ok]', card).onclick = () => review('approved'); $('[data-no]', card).onclick = () => review('rejected'); });
  document.querySelectorAll('[data-reverse]').forEach(b => b.onclick = async () => {
    const reason = await reasonDialog('Reverse these points', 'Use this if the job turns out not to have been done. A negative entry with your reason is added and logged; a signed-off week never changes.', 'e.g. bins were not actually emptied', 'Reverse points');
    if (!reason) return;
    try { await api(`/api/completions/${b.dataset.reverse}/reverse`, { method: 'POST', body: { reason } }); toast('Points reversed'); viewApprovals({ o }); } catch (e) { toast(e.message); } });
}

// ---------- weekly reward text + season ----------
async function viewRewards(params) {
  const week = params.w || S.me.week_start; const [rewards, seasons] = await Promise.all([api(`/api/rewards?week=${week}`), api('/api/seasons')]);
  const scopes = [...(isOwner() ? [{ id: null, name: 'Group-wide board' }] : []), ...S.me.outlets];
  const cur = seasons.current;
  layout('rewards', `<h1>🎁 Weekly reward</h1><p class="muted small">Free text for each week, shown on the leaderboard and in the winners recap. Outlet managers set their outlet's reward; Ivan sets the group-wide one.</p>
    <div class="tabs" id="wtabs">${[S.me.week_start, addDays(S.me.week_start, 7), S.me.last_week].map((w, i) => `<button class="tab ${w === week ? 'on' : ''}" data-w="${w}">${['This week', 'Next week', 'Last week'][i]} · ${weekLabel(w)}</button>`).join('')}</div>
    <div class="grid2" style="margin-top:12px">${scopes.map(s => { const r = rewards.find(x => x.outlet_id === s.id) || {};
      return `<div class="card"><h3>${esc(s.name)}${s.is_active === false ? ' <span class="pill">off</span>' : ''}</h3><label>Reward</label><input type="text" data-t="${s.id ?? 'group'}" value="${esc(r.title || '')}" placeholder="e.g. Golden Spatula + coffee shout">
        <label style="margin-top:8px">Details (optional)</label><input type="text" data-d="${s.id ?? 'group'}" value="${esc(r.details || '')}">
        <div class="row" style="margin-top:10px"><span class="small muted grow">${r.updated_at ? 'Updated ' + fmtTime(r.updated_at) : 'Not set'}</span><button class="btn primary sm" data-save="${s.id ?? 'group'}">Save</button></div></div>`; }).join('')}</div>
    ${isOwner() ? `<h2>Season</h2><div class="card"><div class="formgrid"><div><label>Name</label><input type="text" id="sn" value="${esc(cur?.name || '')}"></div>
      <div><label>Starts (Monday)</label><input type="date" id="ss" value="${cur?.starts_on || S.me.week_start}"></div>
      <div><label>Length</label><select id="sl">${[10, 11, 12].map(n => `<option ${cur?.length_weeks === n ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      <div><label>&nbsp;</label><button class="btn primary" id="ssave">Save season</button></div></div>
      <p class="small muted">Seasons run 10 to 12 weeks (enforced in the database). ${cur ? `Current: week ${cur.current_week} of ${cur.length_weeks}, ends ${fmtDate(cur.ends_on)}.` : ''}</p></div>` : ''}`);
  bindTabs('wtabs', (w) => go('rewards', { w }));
  document.querySelectorAll('[data-save]').forEach(b => b.onclick = async () => { const k = b.dataset.save;
    try { await api('/api/rewards', { method: 'PUT', body: { outlet_id: k, week_start: week, title: $(`[data-t="${k}"]`).value, details: $(`[data-d="${k}"]`).value } }); toast('Reward saved'); } catch (e) { toast(e.message); } });
  if ($('#ssave')) $('#ssave').onclick = async () => { try { await api('/api/seasons', { method: 'PUT', body: { id: cur?.id, name: $('#sn').value, starts_on: $('#ss').value, length_weeks: Number($('#sl').value) } }); toast('Season saved'); } catch (e) { toast(e.message); } };
}

// ---------- messages ----------
async function viewMessages(params) {
  const chans = await api('/api/channels'); const ch = chans.find(c => c.id === params.c) || chans.find(c => c.outlet_id && c.is_everyone) || chans[0];
  const msgs = ch ? await api(`/api/messages?channel=${ch.id}`) : [];
  layout('messages', `<h1>💬 Messages</h1><div class="chatgrid">
    <div class="card chanlist">${chans.map(c => `<div class="chan ${c.id === ch?.id ? 'on' : ''}" data-c="${c.id}"><b>${c.kind === 'direct' ? '✉️ ' + esc(c.members || 'Direct') : (c.outlet_id ? '# ' : '🌏 ') + esc(c.name)}</b><div class="small muted">${c.message_count} messages</div></div>`).join('')}</div>
    <div class="card"><h3>${esc(ch?.name || ch?.members || '')}</h3><div id="thread">${msgs.map(m => `<div class="msg ${m.is_memo ? 'memo' : ''} ${m.pinned ? 'pinned' : ''}">
      <div class="row small"><b>${esc(m.sender)}</b><span class="muted">${fmtTime(m.created_at)}</span>${m.pinned ? '<span class="pill amber">📌 Pinned</span>' : ''}${m.is_memo ? '<span class="pill">Memo</span>' : ''}<span class="grow"></span>
        ${m.is_memo && isMgr() ? `<span class="small muted">Read by ${m.read_count}/${m.audience}</span>` : ''}
        ${isMgr() ? `<button class="btn sm ghost" data-pin="${m.id}" data-p="${!m.pinned}">${m.pinned ? 'Unpin' : 'Pin'}</button>` : ''}</div>
      <div style="white-space:pre-wrap;margin-top:4px">${esc(m.body)}</div></div>`).join('')}</div>
      <div style="margin-top:10px"><textarea id="body" rows="2" placeholder="Write a message…"></textarea>
        <div class="row" style="margin-top:8px">${isMgr() ? '<label style="margin:0"><input type="checkbox" id="memo"> Memo</label><label style="margin:0"><input type="checkbox" id="pin"> Pin</label>' : ''}<span class="grow"></span><button class="btn primary" id="send">Send</button></div></div></div></div>`);
  document.querySelectorAll('[data-c]').forEach(el => el.onclick = () => go('messages', { c: el.dataset.c }));
  document.querySelectorAll('[data-pin]').forEach(b => b.onclick = async () => { await api(`/api/messages/${b.dataset.pin}/pin`, { method: 'POST', body: { pinned: b.dataset.p === 'true' } }); viewMessages({ c: ch.id }); });
  $('#send').onclick = async () => { try { await api('/api/messages', { method: 'POST', body: { channel_id: ch.id, body: $('#body').value, is_memo: $('#memo')?.checked, pinned: $('#pin')?.checked } }); viewMessages({ c: ch.id }); } catch (e) { toast(e.message); } };
  msgs.filter(m => m.is_memo).forEach(m => api(`/api/messages/${m.id}/read`, { method: 'POST' }).catch(() => {}));
}

// ---------- handovers ----------
async function viewHandovers(params) {
  const o = params.o || defaultOutlet(); const list = await api(`/api/handovers?outlet=${o}`);
  const F = [['prep_notes', 'Prep done / outstanding (with dates)'], ['equipment_faults', 'Equipment faults'], ['customer_issues', 'Open customer issues'], ['deliveries', 'Deliveries'], ['staffing', 'Staffing changes']];
  layout('handovers', `<div class="row"><h1 class="grow">📋 Shift handover</h1>${(isMgr() || S.me.user.lead) ? '<button class="btn primary" id="new">+ Write handover</button>' : ''}</div>
    <p class="small muted">Stays open until the incoming lead confirms it. Once confirmed it's locked.</p>${outletTabs(o, { group: false, onlyActive: !isOwner() })}
    ${list.map(h => `<div class="card" style="margin-top:10px"><div class="row"><b class="grow">${fmtDate(h.shift_date)} · ${esc(h.shift.toUpperCase())} · by ${esc(h.written_by_name)}</b>
      ${h.is_weekend_gap ? '<span class="pill amber">Weekend gap</span>' : ''}${h.confirmed_at ? `<span class="pill green">Confirmed by ${esc(h.confirmed_by_name)}</span>` : `<span class="pill red">Open</span>`}</div>
      ${F.map(([k, l]) => h[k] ? `<div class="small" style="margin-top:4px"><span class="muted">${l}:</span> ${esc(h[k])}</div>` : '').join('')}
      ${!h.confirmed_at && h.written_by !== S.me.user.staff_id && (isMgr() || S.me.user.lead) ? `<button class="btn primary sm" style="margin-top:8px" data-conf="${h.id}">I've read it: confirm</button>` : ''}</div>`).join('') || '<p class="muted">No handovers yet.</p>'}`);
  bindTabs('otabs', (v) => go('handovers', { o: v }));
  document.querySelectorAll('[data-conf]').forEach(b => b.onclick = async () => { try { await api(`/api/handovers/${b.dataset.conf}/confirm`, { method: 'POST' }); toast('Confirmed'); viewHandovers({ o }); } catch (e) { toast(e.message); } });
  if ($('#new')) $('#new').onclick = () => { const d = document.createElement('dialog');
    d.innerHTML = `<h3>Write handover</h3><label>Shift</label><select id="hs"><option>am</option><option>pm</option><option selected>close</option></select>${F.map(([k, l]) => `<label style="margin-top:8px">${l}</label><input type="text" data-k="${k}">`).join('')}
      <label style="margin-top:8px"><input type="checkbox" id="wg"> Weekend gap (Sat close → Mon)</label><div class="row" style="margin-top:12px;justify-content:flex-end"><button class="btn ghost" id="cx">Cancel</button><button class="btn primary" id="ok">Save</button></div>`;
    document.body.append(d); d.showModal(); $('#cx', d).onclick = () => d.remove();
    $('#ok', d).onclick = async () => { const b = { outlet_id: Number(o), shift: $('#hs', d).value, is_weekend_gap: $('#wg', d).checked }; d.querySelectorAll('[data-k]').forEach(i => b[i.dataset.k] = i.value);
      try { await api('/api/handovers', { method: 'POST', body: b }); d.remove(); viewHandovers({ o }); } catch (e) { toast(e.message); } }; };
}

// ---------- outlets (owner) ----------
async function viewOutlets() {
  const list = await api('/api/outlets');
  layout('outlets', `<h1>🏢 Outlets</h1><p class="muted small">Rollout order. Each outlet is set up in advance (staff, jobs, settings); switching it on lets its staff log in and puts it on the boards.</p>
    ${list.map(o => `<div class="card row" style="margin-top:10px"><span class="rank">${o.rollout_order}</span><div class="grow"><b>${esc(o.name)}</b>
      <div class="small muted">${o.staff_count} staff · ${o.job_count} jobs${o.activated_at ? ' · live since ' + new Date(o.activated_at).toLocaleDateString('en-AU', { timeZone: 'Australia/Perth', weekday: 'short', day: 'numeric', month: 'short' }) : ''}</div></div>
      ${o.is_active ? '<span class="pill green">Live</span>' : o.rollout_order === Math.min(...list.filter(x => !x.is_active).map(x => x.rollout_order)) ? '<span class="pill blue">Next</span>' : '<span class="pill">Not yet</span>'}
      <button class="btn ${o.is_active ? 'ghost' : 'primary'} sm" data-tog="${o.id}" data-a="${!o.is_active}">${o.is_active ? 'Switch off' : 'Switch on'}</button></div>`).join('')}`);
  document.querySelectorAll('[data-tog]').forEach(b => b.onclick = async () => { if (!confirm(`${b.dataset.a === 'true' ? 'Switch on' : 'Switch off'} this outlet?`)) return;
    await api(`/api/outlets/${b.dataset.tog}/active`, { method: 'POST', body: { active: b.dataset.a === 'true' } }); S.me = await api('/api/me'); viewOutlets(); });
}

// ---------- staff: my jobs (tick off -> pending until a manager approves; offline outbox) ----------
const outbox = { get: () => JSON.parse(localStorage.kq_outbox || '[]'), set: (v) => localStorage.kq_outbox = JSON.stringify(v) };
async function sendTick(item) {
  await api('/api/completions', { method: 'POST', body: { id: item.id, assignment_id: item.assignment_id } });
}
async function flushOutbox() { const items = outbox.get(); const left = [];
  for (const it of items) { try { await sendTick(it); } catch { left.push(it); } } outbox.set(left); return items.length - left.length; }
window.addEventListener('online', () => flushOutbox().then(n => n && toast(`Synced ${n} tick-off${n > 1 ? 's' : ''}`)));
async function viewMy() {
  await flushOutbox().catch(() => {});
  const [jobs, pts] = await Promise.all([api('/api/my-jobs'), api('/api/my-points')]); const queued = outbox.get().map(x => x.assignment_id);
  layout('my', `<h1>✅ My jobs today</h1><p class="small muted">Tap ✓ Done when a job is finished. It earns points once a shift lead or manager approves it.</p>
    ${jobs.map(j => { const st = queued.includes(j.assignment_id) ? 'queued' : j.status;
      return `<div class="job"><div class="pts">+${j.points}</div><div class="grow"><b>${esc(j.title)}</b><div class="small muted">${esc(j.outlet)} · ${esc(j.shift || 'any shift')} · ${VER[j.verification]}</div>
        ${j.review_note ? `<div class="small" style="color:#fca5a5">${esc(j.review_note)}</div>` : ''}</div>
        ${st === 'approved' ? '<span class="pill green">Approved</span>' : st === 'pending' ? '<span class="pill amber">Waiting for sign-off</span>' : st === 'queued' ? '<span class="pill blue">Saved offline</span>'
          : st === 'rejected' ? '<span class="pill red">Not approved</span>' : st === 'reversed' ? '<span class="pill red">Points reversed</span>'
          : `<label class="btn primary" style="display:grid;place-items:center">✓ Done<input type="checkbox" hidden data-t="${j.assignment_id}"></label>`}</div>`; }).join('') || '<p class="muted">No jobs assigned to you today.</p>'}
    <h2>Why I got my points</h2><div class="card">${pts.slice(0, 10).map(p => `<div class="row small" style="padding:4px 0"><b style="min-width:44px;color:${p.points < 0 ? '#fca5a5' : 'var(--gold)'}">${p.points > 0 ? '+' : ''}${p.points}</b><span class="grow">${esc(p.reason)}</span><span class="muted">${fmtTime(p.awarded_at)}</span></div>`).join('') || '<p class="muted">No points yet.</p>'}</div>`);
  const tick = async (assignment_id) => { const item = { id: crypto.randomUUID(), assignment_id };
    try { await sendTick(item); toast('Nice one! Waiting for sign-off.'); } catch { outbox.set([...outbox.get(), item]); toast('No signal: saved, will sync automatically'); } viewMy(); };
  document.querySelectorAll('[data-t]').forEach(i => i.onchange = () => tick(i.dataset.t));
}

// ---------- router ----------
const VIEWS = { board: viewBoard, crowns: viewCrowns, hours: viewHours, jobs: viewJobs, approvals: viewApprovals, rewards: viewRewards,
  messages: viewMessages, handovers: viewHandovers, outlets: viewOutlets, my: viewMy, tablet: viewTablet };
function go(page, params = {}) { const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString(); location.hash = `#/${page}${q ? '?' + q : ''}`; }
async function route() {
  const [path, qs] = location.hash.slice(2).split('?'); const params = Object.fromEntries(new URLSearchParams(qs || ''));
  try {
    const tok = sessionStore.get()?.access_token || null;
    if (!!S.token !== !!tok) S.me = null; S.token = tok;   // picks up a sign-in/out from another tab
    if (!S.token || path === 'login') return viewLogin();
    if (!S.me) { S.me = await api('/api/me'); armIdle(); }
    const page = VIEWS[path] ? path : (S.me.user.role === 'staff' ? 'my' : 'board');
    await VIEWS[page](params);
  } catch (e) { console.error(e); toast(e.message); }
}
window.addEventListener('hashchange', route);
if ('serviceWorker' in navigator && location.hostname !== 'localhost-nosw') navigator.serviceWorker.register('/sw.js').catch(() => {});
route();
