// LOCAL ONLY: serves the real pin-login handler with Deno on a port (Supabase runs index.ts in its Edge runtime).
import { handle } from '../supabase/functions/pin-login/handler.ts';
Deno.serve({ port: Number(Deno.env.get('FN_PORT') || 54331), hostname: '127.0.0.1', onListen: () => {} }, handle);
