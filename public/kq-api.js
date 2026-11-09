// Kitchen Quest client for Supabase (no build step, no SDK): RPC calls, PIN + password sign-in, token refresh.
// Shared by the PWA (app.js) and the Node tests, so both exercise exactly the same calls.
// The app keeps its readable '/api/...' paths; ROUTES maps each to one SQL function (supabase/migrations/*_api_rpc.sql).

export const ROUTES = [
  ['GET', '/api/me', 'api_me'],
  ['GET', '/api/board', 'api_board'],
  ['GET', '/api/crowns', 'api_crowns'],
  ['POST', '/api/crowns/confirm', 'api_confirm_crown'],
  ['POST', '/api/crowns/override', 'api_override_crown'],
  ['POST', '/api/recap', 'api_recap'],
  ['GET', '/api/seasons', 'api_seasons'],
  ['PUT', '/api/seasons', 'api_save_season'],
  ['GET', '/api/outlets', 'api_outlets'],
  ['POST', '/api/outlets/:id/active', 'api_set_outlet_active'],
  ['POST', '/api/tablet', 'api_tablet_code'],
  ['GET', '/api/jobs', 'api_jobs'],
  ['POST', '/api/jobs', 'api_create_job'],
  ['PUT', '/api/jobs/:id', 'api_update_job'],
  ['DELETE', '/api/jobs/:id', 'api_delete_job'],
  ['GET', '/api/staff', 'api_staff'],
  ['POST', '/api/assignments', 'api_create_assignment'],
  ['GET', '/api/assignments', 'api_assignments'],
  ['GET', '/api/my-jobs', 'api_my_jobs'],
  ['POST', '/api/completions', 'api_tick'],
  ['GET', '/api/approvals', 'api_approvals'],
  ['POST', '/api/completions/:id/review', 'api_review'],
  ['GET', '/api/approved', 'api_approved'],
  ['POST', '/api/completions/:id/reverse', 'api_reverse'],
  ['GET', '/api/my-points', 'api_my_points'],
  ['POST', '/api/ledger/:id/reverse', 'api_reverse_ledger'],
  ['POST', '/api/ledger/bonus', 'api_bonus'],
  ['GET', '/api/rewards', 'api_rewards'],
  ['PUT', '/api/rewards', 'api_save_reward'],
  ['GET', '/api/hours', 'api_hours'],
  ['PUT', '/api/hours', 'api_save_hours'],
  ['GET', '/api/settings', 'api_settings'],
  ['PUT', '/api/settings', 'api_save_setting'],
  ['GET', '/api/channels', 'api_channels'],
  ['GET', '/api/messages', 'api_messages'],
  ['POST', '/api/messages', 'api_post_message'],
  ['POST', '/api/messages/:id/pin', 'api_pin_message'],
  ['POST', '/api/messages/:id/read', 'api_read_message'],
  ['GET', '/api/handovers', 'api_handovers'],
  ['POST', '/api/handovers', 'api_write_handover'],
  ['POST', '/api/handovers/:id/confirm', 'api_confirm_handover'],
  ['GET', '/api/audit', 'api_audit'],
];

// '/api/jobs/123?outlet=1' + body -> { fn: 'api_update_job', p: { id: '123', outlet: '1', ...body } }
export function resolve(method, path, body) {
  const [pathname, qs = ''] = path.split('?');
  for (const [m, pattern, fn] of ROUTES) {
    if (m !== method) continue;
    const names = []; const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)')) + '$');
    const hit = pathname.match(re); if (!hit) continue;
    const p = Object.fromEntries(new URLSearchParams(qs));
    names.forEach((n, i) => p[n] = decodeURIComponent(hit[i + 1]));
    return { fn, p: { ...p, ...(body && typeof body === 'object' ? body : {}) } };
  }
  throw Object.assign(new Error(`No route for ${method} ${pathname}`), { status: 404 });
}

// New sb_publishable_ keys go in the apikey header only; legacy anon keys are JWTs and also go as Bearer.
const keyHeaders = (key) => ({ apikey: key, ...(String(key).startsWith('eyJ') ? { authorization: `Bearer ${key}` } : {}) });
const errorOf = (d, r) => (d && (d.message || d.error_description || d.msg || d.error)) || r.statusText || `HTTP ${r.status}`;

export function createClient({ url = '', anonKey, store }) {
  // store: { get(): session|null, set(session|null) }   session = { access_token, refresh_token, expires_at }
  const base = url.replace(/\/$/, '');
  async function http(path, { method = 'POST', body, token } = {}) {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...keyHeaders(anonKey),
      ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { r, data };
  }
  const keep = (s) => { if (!s?.access_token) throw new Error('Sign-in failed');
    const session = { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600) };
    store.set(session); return session; };
  async function refresh() {
    const s = store.get(); if (!s?.refresh_token) return null;
    const { r, data } = await http('/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: s.refresh_token } });
    if (!r.ok) { store.set(null); return null; } return keep(data);
  }
  async function token() {
    let s = store.get(); if (!s) return null;
    if (s.expires_at && s.expires_at - Date.now() / 1000 < 60) s = await refresh();
    return s?.access_token || null;
  }
  async function rpc(fn, args, { retried = false } = {}) {
    const t = await token();
    const { r, data } = await http(`/rest/v1/rpc/${fn}`, { body: args, token: t });
    if (r.status === 401 && t && !retried && await refresh()) return rpc(fn, args, { retried: true });
    if (!r.ok) throw Object.assign(new Error(errorOf(data, r)), { status: r.status, code: data?.code });
    return data;
  }
  return {
    rpc,
    // '/api/...' style call used throughout the app
    api: (path, { method = 'GET', body } = {}) => { const { fn, p } = resolve(method, path, body); return rpc(fn, { p }); },
    session: () => store.get(),
    async signInWithPassword(email, password) {
      const { r, data } = await http('/auth/v1/token?grant_type=password', { body: { email, password } });
      if (!r.ok) throw Object.assign(new Error(r.status === 400 ? 'Wrong email or password' : errorOf(data, r)), { status: r.status });
      return keep(data);
    },
    async signInWithPin({ staff_id, pin, outlet_id, tablet_code }) {
      const { r, data } = await http('/functions/v1/pin-login', { body: { staff_id, pin, outlet_id, tablet_code } });
      if (!r.ok) throw Object.assign(new Error(errorOf(data, r)), { status: r.status });
      return keep(data);
    },
    async roster(outlet_id, tablet_code) { return rpc('login_roster', { p_outlet: Number(outlet_id), p_code: tablet_code }); },
    async signOut() { const t = store.get()?.access_token; store.set(null);
      if (t) await http('/auth/v1/logout', { body: {}, token: t }).catch(() => {}); },
  };
}
