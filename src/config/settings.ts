// ============================================================================
// settings.ts — ZENTRALE Stellschrauben ("eine Schnittstelle" für den Betrieb)
// ============================================================================
// Eine einzige Quelle für alle betriebsseitig einstellbaren Werte. Jeder Wert ist
// per ENV-Variable überschreibbar und hat einen dokumentierten Default. Wird beim
// Start EINMAL gelesen + validiert (ungültig/≤0 → Default).
//
// BEWUSST NICHT hier (dürfen zur Laufzeit umschaltbar bleiben — von Tests/Deploy
// dynamisch gesetzt): AUTH_SERVICE_URL, AUTH_FIELD_ID/NAME, DEV_ENFORCE_ROLES.
//   → liegen in middleware/auth.ts bzw. middleware/authorization.ts.
// Ebenfalls NICHT hier (rein interne Timings ohne Betreiber-Nutzen):
//   Präsenz-TTL (30 s), Heartbeat (10 s), Restore-Suppress (2 s) — im controller.ts.
// Verbindungs-Env (DB_*, REDIS_*, PORT, CORS_ORIGIN, LOG_LEVEL, METRICS_TOKEN)
//   liest das jeweilige Infra-Modul direkt; DB_POOL_MAX ist hier zentralisiert.
// Aufbewahrung/DSGVO liest das CLI-Skript db/retention.ts (RETENTION_MONTHS,
//   CHANGELOG_RETENTION_DAYS) selbst — siehe .env.example.

/** Positive Zahl aus env lesen; leer/ungültig/≤0 → Default. */
const num = (v: string | undefined, def: number): number => {
  if (v === undefined || v.trim() === '') return def;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
};
/** String aus env lesen; leer → Default. */
const str = (v: string | undefined, def: string): string => (v && v.trim() !== '' ? v : def);

export const settings = {
  // ── Change-/Konflikt-Awareness (Schicht 2) ────────────────────────────────
  awareness: {
    /** Konflikt-Fenster: nur Änderungen jünger als das gelten als „frisch" (Regel B/C). */
    freshMs: num(process.env.AWARENESS_FRESH_MS, 45_000),
    /** Drossel des passiven Änderungs-Feeds. */
    feedThrottleMs: num(process.env.AWARENESS_FEED_MS, 2_000),
    /** Fenster „zwei Nutzer ändern dasselbe Element" (Regel C, Overlap). */
    overlapMs: num(process.env.AWARENESS_OVERLAP_MS, 3_000),
  },
  conflict: {
    /** Glocken-Drossel: max. 1 Konflikt-Notification je Session in diesem Fenster. */
    notifyThrottleMs: num(process.env.CONFLICT_NOTIFY_MS, 30_000),
    /** Sperre gegen Konflikt-Spam je (Element, Opfer). */
    cooldownMs: num(process.env.CONFLICT_COOLDOWN_MS, 2_000),
    /** Ruhe nach „Behalten/Privat"-Quittierung, damit derselbe Konflikt nicht sofort erneut kommt. */
    ackSuppressMs: num(process.env.CONFLICT_ACK_SUPPRESS_MS, 5_000),
  },

  // ── WebSocket ──────────────────────────────────────────────────────────────
  ws: {
    /** Max. gleichzeitige WS-Verbindungen pro Nutzer (Abuse-/DoS-Schutz). */
    maxConnPerUser: num(process.env.WS_MAX_CONN_PER_USER, 20),
    /** Max. WS-Frame-Größe in Bytes. */
    maxPayloadBytes: num(process.env.WS_MAX_PAYLOAD, 5 * 1024 * 1024),
  },

  // ── Persistenz / Speichern ─────────────────────────────────────────────────
  save: {
    /** Debounce: erst so lange NACH der letzten Änderung wird der geteilte Stand persistiert. */
    debounceMs: num(process.env.SAVE_DEBOUNCE_MS, 5_000),
    /** TTL des Live-Snapshots im Redis-Cache (Sekunden). */
    redisSnapshotTtlSeconds: num(process.env.REDIS_SNAPSHOT_TTL_SECONDS, 60 * 60 * 24),
  },

  // ── Verlauf (History) ──────────────────────────────────────────────────────
  history: {
    /** Wie viele MANUELLE Stände je Session behalten werden (Auto-Slots zählen NICHT mit). */
    sessionLimit: num(process.env.HISTORY_SESSION_LIMIT, 10),
    /** Wie viele MANUELLE Stände je Nutzer (persönlicher Verlauf; + 1 Auto-Slot). */
    personalLimit: num(process.env.HISTORY_PERSONAL_LIMIT, 5),
  },

  // ── Einladungen ────────────────────────────────────────────────────────────
  invite: {
    /** Gültigkeit eines Einladungs-Tokens in Sekunden (Default 7 Tage). */
    ttlSeconds: num(process.env.INVITE_TTL_SECONDS, 7 * 24 * 3600),
  },

  // ── HTTP / Rate-Limit ──────────────────────────────────────────────────────
  http: {
    /** Max. Größe eines JSON-Request-Bodys (z. B. große Modelle). */
    bodyLimit: str(process.env.HTTP_BODY_LIMIT, '1mb'),
    /** Rate-Limit-Zeitfenster in ms. */
    rateLimitWindowMs: num(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    /** Max. Requests je Fenster/IP. Default: 200 (locker 2000 nur im Dev-Modus). */
    rateLimitMax: num(process.env.RATE_LIMIT_MAX, process.env.NODE_ENV === 'development' ? 2000 : 200),
  },

  // ── Datenbank ──────────────────────────────────────────────────────────────
  db: {
    /** Max. PostgreSQL-Verbindungen im Pool (lässt Raum für eine zweite Instanz). */
    poolMax: num(process.env.DB_POOL_MAX, 25),
  },
} as const;
