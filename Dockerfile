# ── Stage 1: Build ───────────────────────────────────────────────────────────
# Kompiliert TypeScript zu JavaScript.
# Dieser Stage landet nicht im finalen Image — nur das Ergebnis wird übernommen.
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
# tsc → dist/
RUN npm run build

# ── Stage 2: Production ───────────────────────────────────────────────────────
# Minimales Image: nur die kompilierten JS-Dateien und Produktions-Dependencies.
# Kein TypeScript, kein ts-node-dev, keine Dev-Tools — kleineres und sichereres Image.
FROM node:20-alpine AS production

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY db ./db

# Migrationslauf: das Skript selbst und das Startskript, das es vor dem Server aufruft.
# Ohne beides startet der Dienst gegen ein leeres Schema (siehe docker-entrypoint.sh).
COPY migrate-prod.js ./
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 3000

# ENTRYPOINT laeuft immer, CMD ist nur der Vorgabewert dahinter und darf vom
# Compose oder von "docker run" ersetzt werden. Node wird direkt gestartet
# (nicht ueber npm), damit es als Prozess 1 laeuft und SIGTERM sauber erhaelt.
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]