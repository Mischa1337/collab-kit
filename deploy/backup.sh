#!/usr/bin/env bash
# M21 — PostgreSQL-Backup: pg_dump -> gzip -> gpg (AES256, symmetrisch), rotierend.
# Als Cron (z.B. taeglich) oder manuell ausfuehren.
# Benoetigt: DATABASE_URL, BACKUP_PASSPHRASE. Optional: BACKUP_DIR, BACKUP_RETENTION_DAYS.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date +%F_%H-%M)"
OUT="$BACKUP_DIR/coworking_${STAMP}.sql.gz.gpg"

mkdir -p "$BACKUP_DIR"

pg_dump "${DATABASE_URL:?DATABASE_URL nicht gesetzt}" \
  | gzip \
  | gpg --batch --yes --symmetric --cipher-algo AES256 \
        --passphrase "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE nicht gesetzt}" \
  > "$OUT"

echo "[backup] erstellt: $OUT"

# Rotation: Backups aelter als RETENTION_DAYS Tage entfernen
find "$BACKUP_DIR" -name 'coworking_*.sql.gz.gpg' -mtime +"$RETENTION_DAYS" -delete
echo "[backup] Rotation: Backups aelter als ${RETENTION_DAYS} Tage entfernt."

# Beispiel-Cron (taeglich 02:30):
#   30 2 * * *  BACKUP_DIR=/backups DATABASE_URL=... BACKUP_PASSPHRASE=... /pfad/deploy/backup.sh >> /var/log/coworking-backup.log 2>&1
