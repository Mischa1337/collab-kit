# Restore-Drill — Wiederherstellung aus dem Backup proben

> **Grundsatz:** Ein **ungetestetes Backup ist kein Backup.** Dieser Drill weist nach, dass die mit `deploy/backup.sh` erzeugten Dateien tatsächlich wiederherstellbar sind (DSGVO Art. 32 / NIST SP 800-34).

## Ziele (Beispielwerte — mit der IT festlegen)
- **RPO** (max. Datenverlust): 24 h → tägliches Backup.
- **RTO** (max. Wiederanlaufzeit): 1 h.

## Voraussetzung
Mindestens eine Backup-Datei `coworking_<stamp>.sql.gz.gpg` (aus `deploy/backup.sh`) und die `BACKUP_PASSPHRASE`.

## Drill-Schritte
```bash
# 1. Test-Datenbank anlegen (getrennt von Produktion!)
createdb coworking_restore_test

# 2. Backup entschlüsseln → entpacken → einspielen
gpg --batch --yes --decrypt --passphrase "$BACKUP_PASSPHRASE" coworking_<stamp>.sql.gz.gpg \
  | gunzip \
  | psql "postgresql://postgres:postgres@localhost:5432/coworking_restore_test"

# 3. Integrität prüfen (Tabellen + Zeilen vorhanden?)
psql "postgresql://.../coworking_restore_test" -c "\dt"
psql "postgresql://.../coworking_restore_test" -c "SELECT
  (SELECT count(*) FROM sessions)  AS sessions,
  (SELECT count(*) FROM documents) AS documents,
  (SELECT count(*) FROM comments)  AS comments,
  (SELECT count(*) FROM reviews)   AS reviews,
  (SELECT count(*) FROM history)   AS history;"

# 4. Test-DB wieder entfernen
dropdb coworking_restore_test
```

## Erfolgskriterien
- Restore läuft fehlerfrei durch, alle Tabellen sind vorhanden, Zeilenzahlen plausibel.
- Gesamtdauer ≤ RTO.

## Drill-Protokoll (bei jedem Drill ausfüllen)
| Datum | Backup-Datei | Restore-Dauer | Ergebnis (✅/❌) | Prüfer:in | Anmerkungen |
|---|---|---|---|---|---|
|  |  |  |  |  |  |
