#!/usr/bin/env bash
# Downloads the real Supabase building blocks used for local testing (no Docker needed) into ~/bin/sb.
set -euo pipefail
D="${KQ_SB_BIN:-$HOME/bin/sb}"; mkdir -p "$D" && cd "$D"
curl -fsSL -o pgrst.tar.xz https://github.com/PostgREST/postgrest/releases/download/v16.5/postgrest-v16.5-linux-static-x86-64.tar.xz && tar xJf pgrst.tar.xz
curl -fsSL -o auth.tgz https://github.com/supabase/auth/releases/download/v2.197.0/auth-v2.197.0-x86.tar.gz && mkdir -p gotrue && tar xzf auth.tgz -C gotrue
curl -fsSL -o deno.zip https://github.com/denoland/deno/releases/download/v2.9.8/deno-x86_64-unknown-linux-gnu.zip && unzip -oq deno.zip
# Supabase CLI (same version as the deploy workflow). Locally only for: supabase db push --remote "postgresql://postgres:postgres@localhost:54329/<db>?sslmode=disable" --yes
curl -fsSL -o cli.tgz https://github.com/supabase/cli/releases/download/v3.0.0/supabase_linux_amd64.tar.gz && tar xzf cli.tgz supabase
rm -f pgrst.tar.xz auth.tgz deno.zip cli.tgz
./postgrest --version; ./deno --version | head -1; ./supabase --version; ls gotrue/auth
