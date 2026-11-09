# Kitchen Quest: prototype (EXAMPLE DATA)

A points-and-leaderboard game for kitchen and bar jobs across Ivan's outlets. **All staff, jobs, hours, points
and rewards in this prototype are EXAMPLE DATA.** Outlet names are real; nothing else is.

## Run it (on the box)
```bash
cd /workspace/kitchen-quest
scripts/get-local-supabase.sh     # once: real Supabase parts (PostgREST, Supabase Auth, Deno) into ~/bin/sb (no Docker needed)
npm start                         # http://localhost:8787 : Postgres 17 (:54329) + PostgREST + Supabase Auth + pin-login function + the PWA
node server.mjs --reset           # wipe and rebuild: Supabase shim + Supabase Auth migrations + supabase/migrations + seed
npm test                          # 35 role/rule/approval/login tests through the same Supabase client the app uses (RLS on)
npm run seed                      # regenerate supabase/seed.sql + supabase/setup-go-live.sql (dates relative to "today" in Perth)
node scripts/e2e-ui.mjs           # browser: manager sets up the tablet, staff ticks, lead approves, manager rejects/reverses
npm run screenshots               # phone 390x844 + tablet 1024x768 into ./screenshots (server must be running)
scripts/backup.sh                 # pg_dump to ./backups (gpg-encrypted if BACKUP_PASSPHRASE is set)
```
Logins: see `TEST-LOGINS.md` (managers/owner: email + password; staff: tap name + PIN on a set-up outlet tablet).
Going live: **`DEPLOY.md`** (click-by-click for Ivan).

## How it's built (Supabase-native)
- `supabase/migrations/*.sql`: **the whole app logic**. Tables + RLS, rule triggers, and one SQL function per app action
  (`api_*`, SECURITY INVOKER so RLS applies, callable only by signed-in users), `login_roster`, `pin_login_check`
  (service role only, 5 wrong PINs = 15 min lockout), pg_cron schedules (weekly winners `0 16 * * 0` UTC = Monday 00:00 AWST),
  and SQL-editor-only go-live helpers (`admin_add_person`, `admin_add_to_outlet`, `admin_set_pin`, `bootstrap_owner`).
- `supabase/functions/pin-login`: Edge Function. Tablet code + name + PIN → checks via `pin_login_check` → creates/uses a
  Supabase Auth user whose id is the staff member's `auth_user_id` → returns a normal Supabase session. Managers and the
  owner use Supabase email + password; sign-ups are off.
- `public/`: vanilla-JS PWA (no build step). `kq-api.js` is a tiny Supabase client (REST RPC + Auth + the function);
  `config.js` (project URL + publishable key) is written at deploy by `scripts/write-config.mjs`, which refuses secret keys.
- `server.mjs` (local only): a stand-in for Supabase's API gateway. Routes `/rest/v1` to PostgREST, `/auth/v1` to
  Supabase Auth, `/functions/v1/pin-login` to Deno, maps the publishable/secret keys like Supabase does, serves
  `/config.js` and runs `cron.job` entries on schedule (pg_cron stand-in). **No app logic lives here.**
- `local/00_supabase_shim.sql`: the Supabase roles, `auth` schema owner, default grants and a `cron.schedule()` stub.
- **No photos, location or audio** are collected or stored anywhere (no photo columns, no uploads, no object storage).
- `.github/workflows/deploy-supabase.yml`: one-click deploy (migrations, function, first data). `weekly-backup.yml` +
  `scripts/backup.sh`: weekly encrypted backup as a GitHub Actions artifact (free, no card). See `docs/HOSTING.md`.

## Rules implemented (summary)
- Week = Monday 00:00 to Sunday 23:59:59 **Australia/Perth (AWST, UTC+8)**, explicit in SQL (`perth_week_start()`).
- Ranking = plain **points per hour** at every outlet and on the group board (group = total points ÷ total hours,
  dual-outlet staff appear once). No Quest Score, blending or shout-out rate boosts (steering overrides v5–v7 here).
- Min hours to rank: **10 h/week** (Ivan's setting) for all outlets and the group board, owner-editable per outlet. Under it or on approved leave = unranked; top-3 streak pauses.
- **Everyone competes:** staff, shift leads and managers are all on the boards (no opt-out). The owner (Ivan) is excluded.
  The DB enforces that nobody approves their own completion (`no_self_review`) and nobody earns points they awarded
  themselves (`no_self_award`), so a manager never earns points on a job they signed off; managers' own jobs go to another manager or Ivan.
- **Approval flow:** a tick-off is **pending and earns nothing** until a manager, an outlet's shift lead (not their own) or Ivan approves it. Managers can
  **reject** a pending tick (reason required, no points) or **reverse** an approved one if the job wasn't really done
  (`reverse_completion()`: reason required, adds a negative `reversal` ledger row, audit-logged, follows the
  `credited_week` rule, can't be undone or repeated). Staff see "Waiting for sign-off / Approved / Not approved / Points reversed".
- **Shift leads** are set per outlet (`staff_outlets.is_lead`; every active outlet has at least one). At their outlet a lead
  can **approve, reject and reverse other people's ticks**, the same as a manager, and write/confirm handovers.
  Leads **can't add or edit jobs** (managers and Ivan only), assignments, staff, bonuses or rewards.
  **Nobody signs off their own tick:** a lead's ticks go to another lead, a manager or Ivan. **Approving earns the approver nothing.**
  Enforced in RLS + guard triggers (`reviews_outlet()`, `guard_completion`, `no_self_review`, `no_self_award`) and in the API.
- Ties: more verified jobs, then more deep cleans.
- Pending winner computed at Monday 00:00 AWST (`crown_weekly_winners()`); **only the owner** approves/overrides (audited, reason required).
  Signing off **locks that week's hours** in the DB.
- **Only the owner** enters/edits hours; managers read their outlet's hours; staff see only their own.
- Managers (their outlet only): jobs, staff, assignments, sign-off of completions, weekly reward text. Staff can't edit jobs.
- Seasons: 10–12 weeks (CHECK), Monday start, owner-only; Season Champion needs ranked weeks ≥ 60% (example, v7).
- Points ledger is append-only (reversals are new rows). Each row has `original_week` (when the job was done) and
  `credited_week` (which board it counts on). **A signed-off week never changes:** approving a late tick-off from a
  signed-off week credits the points to the current open week, and the approvals queue says so.
- Admin changes go to `audit_log` with old/new values. **Only the owner can read the audit log** (RLS + API).
- Hours window: past weeks any time until signed off; the **current week opens Sunday 18:00 AWST** (reminder 21:00),
  winners calculate Monday 00:00 AWST, Ivan approves Monday. The crown sign-off screen lists what's still missing
  (staff with no hours, tick-offs pending approval, unranked count). Approval **warns, never blocks**.
- Shout-outs (later phase, not built) are **recognition and badges only**: no points, no change to points per hour,
  rankings, crowns or streaks.
