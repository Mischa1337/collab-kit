# ── Stage 1: Build ───────────────────────────────────────────────────────────
# Kompiliert TypeScript zu JavaScript.
# Dieser Stage landet nicht im finalen Image — nur das Ergebnis wird übernommen.
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
# tsc → dist/  UND  esbuild-Bundle → public/dist/editor-bundle.js (M10-Playground braucht es).
RUN npm run build && npm run build:editor

# ── Stage 2: Production ───────────────────────────────────────────────────────
# Minimales Image: nur die kompilierten JS-Dateien und Produktions-Dependencies.
# Kein TypeScript, kein ts-node-dev, keine Dev-Tools — kleineres und sichereres Image.
FROM node:20-alpine AS production

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY db ./db
# public/ = M10 SQL-Playground (wird im Dev-Modus unter / ausgeliefert; in Prod ungenutzt).
# Aus dem Builder kopiert, damit das dort gebaute public/dist/editor-bundle.js mitkommt.
# Nötig, weil das Compose das Image mit NODE_ENV=development fährt.
COPY --from=builder /app/public ./public

EXPOSE 3000

CMD ["npm", "start"]