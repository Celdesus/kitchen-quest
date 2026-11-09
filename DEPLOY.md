# Going live: click-by-click checklist (Ivan)

Kitchen Quest runs on three free services. **None needs a card** (checked 2 Nov 2026). Nothing has been signed up for
on your behalf: you create the accounts, and nobody else needs your passwords.

| Service | What it does | Plan |
|---|---|---|
| **GitHub** | Holds the code (private), runs the one-click deploy and the weekly backup | Free |
| **Supabase** | Database, sign-in, the PIN-login function, the Monday 00:00 winner job | Free (no card) |
| **Cloudflare Pages** | The website staff open on the tablet/phone (`https://kitchen-quest.pages.dev`) | Free (no card) |

Allow about 45 minutes. Keep a password manager open: you will save five things in it (marked 🔐).
Never paste any 🔐 item into chat or email.

---

## Part 1: GitHub (10 min)
1. Go to **github.com** → **Sign up** (business email) → verify the email. Choose the **Free** plan.
2. Top right **+** → **New repository** → name `kitchen-quest` → **Private** → leave everything else unticked → **Create repository**.
3. Get the code into it. Either:
   - **Easiest:** reply with the repository address (e.g. `github.com/your-name/kitchen-quest`) and add the helper
     as a collaborator (**Settings → Collaborators → Add people**) when asked; the code is pushed for you. Or
   - **Yourself:** install **GitHub Desktop** → **File → Clone repository** → pick `kitchen-quest` → unzip
     `kitchen-quest-deploy.zip` into that folder (it includes a hidden `.github` folder, keep it) →
     **Commit to main** → **Push origin**.

## Part 2: Supabase (15 min)
4. Go to **supabase.com** → **Start your project** → **Continue with GitHub** (uses the account from step 1).
5. **New organisation** → name `Kitchen Quest` → type *Company* → plan **Free** → **Create organisation**.
6. **New project**:
   - Name `kitchen-quest`
   - **Database password** → **Generate a password** → **copy it** 🔐 (*Supabase database password*)
   - Region **Oceania (Sydney)** (closest to Perth; Southeast Asia (Singapore) also fine)
   - Leave the security options at their defaults (**Data API on**; automatic RLS can be on or off, every table has RLS anyway)
   - **Create new project** and wait ~2 minutes until it says the project is ready.
7. **Authentication** (left menu) → **Sign In / Providers** (may be called *Providers* or *Settings*):
   - **Allow new users to sign up: OFF** ← important: only you add logins
   - **Confirm email: OFF**
   - Email provider: **ON** (default) → **Save**.
8. **Authentication → URL Configuration** → **Site URL** = `https://kitchen-quest.pages.dev` → **Save**.
   (If Cloudflare gives you a different address in step 20, come back and change it.)
9. **Database → Extensions** → search `pg_cron` → switch **on** (if it asks for a schema, keep the default).
   This runs the weekly winners at **Monday 00:00 Perth time**. (The deploy also switches it on; doing it here is a safe double-check.)
10. Note your **project ref**: it's the 20 letters in the browser address `supabase.com/dashboard/project/<project-ref>`
    (also under **Project Settings → General → Project ID**).
11. Click **Connect** (top of the project page) → **Connection string** → **Session pooler** → copy the URI.
    Replace `[YOUR-PASSWORD]` with the database password from step 6 🔐 (*DATABASE_URL*).
12. Your account menu (bottom left avatar) → **Account preferences → Access Tokens** → **Generate new token** →
    name `kitchen-quest deploy`, expiry **30 days** → copy it 🔐 (*Supabase access token*). You can revoke it after go-live.
13. **Project Settings → API Keys**: note the **Publishable key** (`sb_publishable_…`). This one is safe in the website.
    **Do not copy the Secret key anywhere**: the PIN-login function gets it from Supabase automatically.

## Part 3: GitHub secrets + one-click deploy (10 min)
14. In your GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**, add five:

    | Name | Value |
    |---|---|
    | `SUPABASE_ACCESS_TOKEN` | the token from step 12 🔐 |
    | `SUPABASE_PROJECT_REF` | the project ref from step 10 |
    | `SUPABASE_DB_PASSWORD` | the database password from step 6 🔐 |
    | `DATABASE_URL` | the Session pooler URI from step 11 🔐 |
    | `BACKUP_PASSPHRASE` | a new long passphrase 🔐 (*backup passphrase*; backups can't be opened without it) |

15. Repo → **Actions** tab → if asked, **I understand my workflows, go ahead and enable them**.
16. **Deploy to Supabase** (left list) → **Run workflow** →
    - **Data to load:** `go-live` (real outlets, all switched off, no example people) *or* `example-demo`
      (the made-up example staff, to try it first; you can't switch from demo to go-live later without a reset)
    - **owner_email:** the email you'll sign in with
    - **site_url:** leave as is unless Cloudflare gives a different address
    - **Run workflow**. Wait for the green tick (~3 min). If it's red, open it and send a screenshot of the red step.
17. Back in **Supabase → Authentication → Users → Add user → Create new user**: your **owner_email** from step 16, a
    password 🔐 (*Kitchen Quest owner password*), **Auto Confirm User: ticked** → **Create user**.

## Part 4: Cloudflare Pages (10 min)
18. Go to **dash.cloudflare.com** → **Sign up** (business email) → verify. Choose **Free**. No domain is needed.
19. **Workers & Pages → Create** → choose the **Pages** tab (if you only see Workers, click *"Looking to deploy Pages? Get started"*)
    → **Import an existing Git repository** → **Connect GitHub** → allow access to **only** `kitchen-quest` → **Begin setup**.
20. Set up builds:
    - Project name `kitchen-quest` (the site becomes `https://kitchen-quest.pages.dev`; if taken, note the address it gives you)
    - Production branch `main` · Framework preset **None**
    - Build command `node scripts/write-config.mjs` · Build output directory `public`
    - **Environment variables** → add `SUPABASE_URL` = `https://<project-ref>.supabase.co` and
      `SUPABASE_PUBLISHABLE_KEY` = the publishable key from step 13. (For the example demo, also `KQ_EXAMPLE_DATA` = `1` to show the "Example data" banner.)
    - **Save and Deploy**. The build refuses a secret key, so a wrong paste can't leak it.
21. If your address isn't `kitchen-quest.pages.dev`: update step 8 (Site URL) and re-run step 16 with that **site_url**
    and **Data to load: none**.

## Part 5: First sign-in and the first outlet (10 min)
22. Open the site → **Manager or owner? Sign in with email** → your email + password from step 17.
23. **Outlets** → switch on **Boughshed Kitchen** (go-live data starts with every outlet off).
24. Add people: **Supabase → SQL Editor → New query**, one line per person, then **Run**:
    ```sql
    select public.admin_add_person('Maya Brooks', 'boughshed-kitchen', 'staff', '4821');          -- name as it shows on the tablet, 4-digit PIN
    select public.admin_add_person('Lachlan Harris', 'boughshed-kitchen', 'staff', '7310', true);  -- true = shift lead (at least one per outlet)
    select public.admin_add_person('Jack Wiremu', 'boughshed-kitchen', 'manager', p_email => 'jack@yourbusiness.com.au');
    select public.admin_add_to_outlet('Maya Brooks', 'monkey-bar-kitchen');                        -- someone who works at two outlets
    select public.admin_set_pin('Maya Brooks', '5590');                                            -- forgotten PIN
    ```
    Tell each person their PIN in person. For each **manager**, also do **Authentication → Users → Add user**
    with the same email, a temporary password, **Auto Confirm User** ticked; they're linked on first sign-in.
25. On the kitchen tablet: sign in as yourself → **📱 Tablet set-up** → **Use this device as the Boughshed Kitchen tablet** →
    sign out. The tablet now shows the Boughshed names; staff tap their name and type their PIN.
    (A phone or computer that isn't set up can't see names or try PINs. **New code** makes every tablet for that outlet re-do this step.)
26. Add to home screen: on the tablet's browser menu → **Add to Home Screen** / **Install app**.
27. Backups: GitHub → **Actions → weekly-backup → Run workflow** once; check it goes green. After that it runs every Monday 02:00 Perth time.

The weekly winners run themselves at **Monday 00:00 Perth time** (pg_cron, `0 16 * * 0` UTC); you approve the crown on Monday.

---

## ✅ What to send back (privately)
Send these **through the password manager's share feature or a private message, not a group chat**:
1. The **website address** (e.g. `https://kitchen-quest.pages.dev`).
2. The **Supabase project ref** (step 10) and **publishable key** (step 13). Both are safe-to-share, but keep them private anyway.
3. Whether you loaded **go-live** or **example-demo** data, and that the **Deploy to Supabase** run went green
   (or a screenshot of the red step).
4. Whether you could sign in (step 22) and set up the tablet (step 25).

**Never send:** the database password, `DATABASE_URL`, the access token, the Supabase **secret** key, the backup
passphrase or anyone's PIN/password. Nobody helping you needs them; they live only in GitHub secrets and your password manager.

---

## Reference
- **Updating later:** push code to GitHub → Cloudflare redeploys the website automatically; for database or
  PIN-login changes, run **Deploy to Supabase** again with **Data to load: none** (only new migrations run).
- **Free-tier limits** (500 MB database, 50k users, 5 GB egress) are far above 4 outlets / ~60 staff; see `docs/HOSTING.md`.
  A Free project pauses after 7 days with **no** use; a pilot in daily use won't.
- **Don't enable** Cloudflare R2 or Supabase paid add-ons: Kitchen Quest uses no file storage (no photos).
- **What runs where:** `supabase/migrations/*` (tables, RLS, all app logic as SQL functions, pg_cron schedule) ·
  `supabase/functions/pin-login` (tablet PIN → Supabase session) · `public/` (the PWA; `config.js` is written at build time
  by `scripts/write-config.mjs` from the Cloudflare environment variables).
