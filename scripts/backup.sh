#!/usr/bin/env bash
# Weekly logical backup of the Kitchen Quest database. Supabase Free has no automatic backups, so this is the
# safety net. NO card needed anywhere: in production it runs on a free GitHub Actions runner in a PRIVATE repo and
# the encrypted dump is kept as a workflow artifact (90 days; GitHub Free gives 500 MB artifact storage).
# Needs: pg_dump 17. Optional gpg for encryption.
# Env: DATABASE_URL       (Supabase: Connect > Session pooler connection string, port 5432)
#      BACKUP_PASSPHRASE  (optional locally, required in CI): encrypts the dump with gpg AES256
# Local test: DATABASE_URL=postgres://postgres:postgres@localhost:54329/kitchen_quest ./scripts/backup.sh
set -euo pipefail
STAMP=$(TZ=Australia/Perth date +%Y-%m-%d_%H%M)AWST
OUT_DIR="${OUT_DIR:-./backups}"; mkdir -p "$OUT_DIR"
FILE="$OUT_DIR/kitchen-quest_${STAMP}.dump"
pg_dump --format=custom --no-owner --no-privileges --schema=public --file="$FILE" "$DATABASE_URL"
if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  gpg --batch --yes --pinentry-mode loopback --passphrase "$BACKUP_PASSPHRASE" --symmetric --cipher-algo AES256 -o "$FILE.gpg" "$FILE"
  rm -f "$FILE"; FILE="$FILE.gpg"
fi
echo "backup: $(du -h "$FILE" | cut -f1) -> $FILE"
# Restore: gpg -d file.dump.gpg > file.dump && pg_restore --clean --no-owner -d "$DATABASE_URL" file.dump
