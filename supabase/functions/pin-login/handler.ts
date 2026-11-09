// Kitchen Quest: staff PIN login on an outlet tablet -> a normal Supabase Auth session for that staff member.
// Flow: check tablet code + PIN in SQL (pin_login_check, service role only, 5 wrong PINs = 15 min lock)
//   -> make sure the staff member has a Supabase Auth user (id = staff.auth_user_id, hidden internal email)
//   -> admin "magic link" token (nothing is emailed) -> exchange it for a session -> return the session.
// Managers and the owner do NOT use this: they sign in with email + password.
const env = (k: string, d = '') => Deno.env.get(k) ?? d;
const URL_ = () => env('SUPABASE_URL').replace(/\/$/, '');
// Supabase injects the new keys as JSON ({"default": "sb_secret_..."}); the legacy JWT keys are the fallback.
const fromJson = (k: string) => { try { return JSON.parse(env(k) || '{}')?.default || ''; } catch { return ''; } };
const SERVICE = () => env('KQ_SERVICE_KEY') || fromJson('SUPABASE_SECRET_KEYS') || env('SUPABASE_SERVICE_ROLE_KEY');
const ANON = () => env('KQ_ANON_KEY') || fromJson('SUPABASE_PUBLISHABLE_KEYS') || env('SUPABASE_ANON_KEY');
const DOMAIN = () => env('STAFF_EMAIL_DOMAIN', 'staff.kitchenquest.invalid');
const cors = () => ({ 'access-control-allow-origin': env('ALLOWED_ORIGIN', '*'), 'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS', vary: 'origin' });
// Legacy keys are JWTs (send as Bearer too); new sb_publishable_/sb_secret_ keys go in the apikey header only.
const keyHeaders = (k: string) => ({ apikey: k, ...(k.startsWith('eyJ') ? { authorization: `Bearer ${k}` } : {}), 'content-type': 'application/json' });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(), 'content-type': 'application/json' } });

async function call(path: string, key: string, init: RequestInit = {}) {
  const r = await fetch(URL_() + path, { ...init, headers: { ...keyHeaders(key), ...(init.headers || {}) } });
  const text = await r.text(); let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: r.ok, status: r.status, data };
}

export async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors() });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!URL_() || !SERVICE() || !ANON()) return json({ error: 'Server not configured (SUPABASE_URL / keys)' }, 500);
  let b: any; try { b = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const { staff_id, pin, outlet_id, tablet_code } = b || {};
  if (!staff_id || !pin || !outlet_id || !tablet_code) return json({ error: 'staff_id, pin, outlet_id and tablet_code are required' }, 400);

  // 1) tablet code + PIN (+ lockout) in the database
  const chk = await call('/rest/v1/rpc/pin_login_check', SERVICE(), { method: 'POST',
    body: JSON.stringify({ p_staff: staff_id, p_pin: String(pin), p_outlet: Number(outlet_id), p_code: String(tablet_code) }) });
  if (!chk.ok) return json({ error: 'Login check failed' }, 502);
  if (!chk.data?.ok) return json({ error: chk.data?.error || 'Wrong PIN' }, 401);
  const uid: string = chk.data.auth_user_id;

  // 2) the staff member's Supabase Auth user (created on first login with the same id as staff.auth_user_id)
  let u = await call(`/auth/v1/admin/users/${uid}`, SERVICE());
  if (u.status === 404 || (u.ok && !u.data?.id)) {
    u = await call('/auth/v1/admin/users', SERVICE(), { method: 'POST', body: JSON.stringify({ id: uid, email: `staff-${uid}@${DOMAIN()}`,
      email_confirm: true, app_metadata: { kq_staff_id: chk.data.staff_id, kq_login: 'pin' } }) });
  }
  if (!u.ok || !u.data?.email) return json({ error: 'Could not prepare the login' }, 502);

  // 3) one-time token (not emailed) -> 4) session
  const link = await call('/auth/v1/admin/generate_link', SERVICE(), { method: 'POST', body: JSON.stringify({ type: 'magiclink', email: u.data.email }) });
  const token_hash = link.data?.hashed_token ?? link.data?.properties?.hashed_token;
  if (!link.ok || !token_hash) return json({ error: 'Could not create the session' }, 502);
  const s = await call('/auth/v1/verify', ANON(), { method: 'POST', body: JSON.stringify({ type: 'email', token_hash }) });
  if (!s.ok || !s.data?.access_token) return json({ error: 'Could not create the session' }, 502);
  const { access_token, refresh_token, expires_in, expires_at, token_type } = s.data;
  return json({ access_token, refresh_token, expires_in, expires_at, token_type, user: { id: s.data.user?.id, name: chk.data.name } });
}
