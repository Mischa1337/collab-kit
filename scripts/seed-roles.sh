#!/usr/bin/env bash
# Legt die festen Test-Sessions (stabile UUIDs) + vorgefertigte Nutzer an — idempotent.
# GETRENNT pro Tool, damit M10- und M11-Daten sich nicht vermischen:
#   ID beginnt mit 10… = M10 (Playground) · 11… = M11 (Modeling)
# Nach einer frischen DB (docker compose down -v) EINMAL ausführen; die Links unten
# sind dann immer gleich. Namen sind case-sensitive (?devUser=Alice ≠ alice).
#
#   ./scripts/seed-roles.sh
#
# Voraussetzung: Container laufen (docker compose up -d) und – für echte Rollen –
# der Enforcer ist an (cp docker-compose.override.yml.example docker-compose.override.yml).
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose exec -T postgres psql -U postgres -d projekt5 -q < db/seed-roles.sql

# $1=mode(m10|m11) $2=SID $3=Label; danach user:role …
links() {
  local mode="$1" SID="$2" LABEL="$3"; shift 3
  echo
  echo "  ── $LABEL   ($SID)"
  for ur in "$@"; do
    if [ "$mode" = m11 ]; then
      printf '     http://localhost:8085/#/modeling?session=%s&devUser=%s&autoconnect=1   (%s)\n' "$SID" "${ur%%:*}" "${ur##*:}"
    else
      printf '     http://localhost:3000/playground.html?session=%s&user=%s   (%s)\n' "$SID" "${ur%%:*}" "${ur##*:}"
    fi
  done
}

ROLLEN="alice:owner bob:member carol:commentator dave:spectator"
TEAMA="erin:owner frank:member grace:member heidi:member ivan:member judy:spectator mallory:commentator"
TEAMB="niaj:owner erin:member frank:member grace:member heidi:member ivan:member olivia:member judy:spectator mallory:commentator"

echo
echo "=================================================================="
echo "  M11 (Modeling, :8085) — ID beginnt mit 11:"
echo "=================================================================="
links m11 '11111111-1111-1111-1111-111111111111' 'Session 1 — Rollen-Test (4)' $ROLLEN
links m11 '11222222-2222-2222-2222-222222222222' 'Session 2 — Team A (7)'      $TEAMA
links m11 '11333333-3333-3333-3333-333333333333' 'Session 3 — Team B (9)'      $TEAMB

echo
echo "=================================================================="
echo "  M10 (Playground, :3000) — ID beginnt mit 10:"
echo "=================================================================="
links m10 '10111111-1111-1111-1111-111111111111' 'Session 1 — Rollen-Test (4)' $ROLLEN
links m10 '10222222-2222-2222-2222-222222222222' 'Session 2 — Team A (7)'      $TEAMA
links m10 '10333333-3333-3333-3333-333333333333' 'Session 3 — Team B (9)'      $TEAMB
