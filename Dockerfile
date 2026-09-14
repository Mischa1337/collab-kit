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

EXPOSE 3000

CMD ["npm", "start"]