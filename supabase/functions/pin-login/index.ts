// Supabase Edge Function entry point. Deploy: supabase functions deploy pin-login --no-verify-jwt
import { handle } from './handler.ts';
Deno.serve(handle);
