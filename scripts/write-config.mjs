// Writes public/config.js from environment variables at deploy time (Cloudflare Pages build command:
//   node scripts/write-config.mjs ). Only PUBLIC values go here: the Supabase project URL and the anon /
//   publishable key (safe in a browser; RLS protects the data). Never put the service_role / secret key here.
import { writeFileSync } from 'node:fs';
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
if (!url || !key) { console.error('Set SUPABASE_URL and SUPABASE_ANON_KEY (or SUPABASE_PUBLISHABLE_KEY) in the Pages project settings.'); process.exit(1); }
if (/service_role|sb_secret_/.test(key) || (key.startsWith('eyJ') && JSON.parse(Buffer.from(key.split('.')[1], 'base64url')).role === 'service_role')) {
  console.error('That is the SECRET service_role key. Use the anon / publishable key.'); process.exit(1); }
const cfg = { supabaseUrl: url.replace(/\/$/, ''), anonKey: key, exampleData: /^(1|true|yes)$/i.test(process.env.KQ_EXAMPLE_DATA || '') };
writeFileSync(new URL('../public/config.js', import.meta.url), `window.KQ_CONFIG = ${JSON.stringify(cfg)};\n`);
console.log('public/config.js written for', cfg.supabaseUrl, cfg.exampleData ? '(example data banner on)' : '');
