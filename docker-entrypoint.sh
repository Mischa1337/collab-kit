#!/bin/sh
# Startskript des Containers: spielt zuerst ausstehende Datenbankmigrationen ein,
# danach wird der eigentliche Befehl (CMD oder "command:" aus dem Compose) gestartet.
#
# Warum hier und nicht im Anwendungscode: So gilt es fuer jeden Start des Images,
# also auch dann, wenn jemand das fertige Image aus der Registry zieht oder es in
# Kubernetes faehrt, ohne unser Compose zu benutzen.
#
# Abschaltbar ueber RUN_MIGRATIONS=false. Das ist fuer Umgebungen gedacht, in denen
# der Datenbankbenutzer keine Rechte zum Anlegen von Tabellen hat und das Schema
# getrennt eingespielt wird.
set -e

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  # Auf die Datenbank warten. Im Compose regelt das zwar depends_on, beim direkten
  # Start des Images gibt es diese Zusicherung aber nicht.
  i=1
  until node -e "
    const { Client } = require('pg');
    const c = new Client({
      host: process.env.DB_HOST, port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME, user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });
    c.connect().then(() => c.end()).catch(() => process.exit(1));
  " 2>/dev/null; do
    if [ "$i" -ge 30 ]; then
      echo "Datenbank nach 30 Versuchen nicht erreichbar, breche ab." >&2
      exit 1
    fi
    echo "Warte auf die Datenbank ($i/30) ..."
    i=$((i + 1))
    sleep 1
  done

  echo "Spiele ausstehende Migrationen ein ..."
  node migrate-prod.js
else
  echo "RUN_MIGRATIONS=false, Migrationen werden uebersprungen."
fi

# exec ersetzt die Shell durch den Zielprozess. Dadurch laeuft Node als Prozess 1
# und bekommt SIGTERM direkt, "docker stop" beendet den Container also sofort
# statt erst nach dem Timeout.
exec "$@"
