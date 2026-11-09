# Hosting design (nothing has been signed up for)

**Target:** Cloudflare Pages (the PWA) + Supabase Free (Postgres, Auth, RLS, pg_cron) + GitHub (private repo, Actions backups).
All three are free with **no card**. Step-by-step setup and the exact accounts/settings Ivan needs: **`DEPLOY.md`**.
Supabase Pro is a later decision for Ivan.

## How the pieces fit
- **Cloudflare Pages** serves `public/` (static PWA). Build command `node scripts/write-config.mjs` writes `config.js`
  from `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY`. `public/_headers` sets security headers and stops `config.js`/`sw.js` caching.
- **Supabase** runs everything else: the browser calls `rest/v1/rpc/api_*` (RLS-checked SQL functions) with the user's
  session; managers/owner sign in with Supabase Auth email + password; staff sign in through the `pin-login` Edge
  Function from a set-up outlet tablet (per-outlet tablet code + name + PIN, lockout after 5 wrong PINs).
- **GitHub Actions**: `deploy-supabase.yml` (manual: `supabase db push`, deploy `pin-login`, optional first data) and
  `weekly-backup.yml`. Deploy uses Supabase CLI 3.0.0 (pinned) with `--remote=<project ref> --yes`.
- Keys: the browser only ever has the **publishable** key. The Edge Function gets the secret key from Supabase's own
  environment (`SUPABASE_SECRET_KEYS`, falling back to the legacy `SUPABASE_SERVICE_ROLE_KEY`); it is never typed anywhere.

## No photos
Kitchen Quest stores **no photos, location or audio**. A tick-off is a tap; a manager (or Ivan) approves, rejects or
later reverses it. That removes the only large storage need, so no object storage (R2/Supabase Storage) is used at all.

## Weekly winners
`crown_weekly_winners()` is one idempotent SQL function, scheduled with **pg_cron inside Supabase** at
`0 16 * * 0` (pg_cron uses UTC: Sunday 16:00 UTC = **Monday 00:00 AWST**). Running it twice changes nothing.
Note: pg_cron doesn't run while a Free project is paused (after 7 days with no activity), so a live pilot won't hit this.

## Backups (free, no card)
Supabase Free has no downloadable backups, so `.github/workflows/weekly-backup.yml` runs every
**Monday 02:00 AWST** (`0 18 * * 0` UTC) in a **private** GitHub repo:
`scripts/backup.sh` → `pg_dump -Fc` → encrypted with gpg (AES-256, `BACKUP_PASSPHRASE`) → uploaded as an Actions
**artifact kept 90 days** (~13 weekly backups). Repo secrets: `DATABASE_URL` (Supabase *session pooler* string)
and `BACKUP_PASSPHRASE` (keep a copy somewhere safe; without it the backups can't be opened).
GitHub Free gives 500 MB artifact storage and 2,000 Actions minutes/month; a backup is ~1–5 MB and ~1 minute.
With no payment method on the account, GitHub **blocks** usage at the quota rather than billing.

Restore: download the artifact, then
`gpg -d kq-YYYYMMDD.dump.gpg > kq.dump && pg_restore --clean --no-owner -d "$DATABASE_URL" kq.dump`.

## Free-tier check: 4 outlets, ~60 staff
| Resource | Free limit | Expected use | Fits? |
|---|---|---|---|
| Database | 500 MB | ~15–20 MB/month (pilot seed: 13 MB for 7 weeks of one outlet) | ✓ ~2 years, then prune audit/old weeks |
| File storage | 1 GB | none (no photos) | ✓ |
| Monthly active users | 50,000 | ~65 | ✓ |
| Egress | 5 GB | small JSON API traffic, < 0.5 GB/month | ✓ |
| Edge Function calls (PIN login) | 500k/month | a few thousand | ✓ |
| Cloudflare Pages | unlimited static requests, 500 deploys/month | a handful of deploys | ✓ |
| GitHub Actions | 2,000 min, 500 MB artifacts | ~5 min/month, ~65 MB stored | ✓ |

**Verdict:** fits the free tiers comfortably for all four outlets.
**What pushes it to paid:** wanting Supabase's own daily backups/point-in-time restore or no risk of the 7-day
inactivity pause (Supabase Pro US$25/month, about A$36 + GST at A$1.42/US$), or the database passing 500 MB
(years away unless the audit log is never pruned).

## Weekly timeline (AWST, UTC+8)
- **Sunday 18:00:** the owner can enter hours for the current week (`hours_entry_open()`; earlier is refused by the DB).
- **Sunday 21:00:** Ivan's reminder to enter hours.
- **Monday 00:00 (= Sunday 16:00 UTC):** `crown_weekly_winners()` records pending winners.
- **Monday 02:00:** encrypted backup to a GitHub artifact.
- **Monday:** Ivan reviews the crown sign-off checklist (`crown_readiness()`) and approves; that week's hours lock and
  any later approvals or reversals for it are credited to the open week.

Shout-outs, when built, are recognition/badges only and don't affect points per hour, so they add no ranking load.
