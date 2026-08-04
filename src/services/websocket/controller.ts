import { Server, IncomingMessage } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { setupWSConnection, setPersistence, docs as yjsDocs } from 'y-websocket/bin/utils';
import { redis, subscriber } from '../../config/redis';
import { db } from '../../config/db';
import { validateToken } from '../../middleware/auth';
import { checkSessionMembership, getSessionRole, devEnforcesRoles, SessionRole } from '../../middleware/authorization';
import { setupReadonlyConnection } from './readonly';
import { logger } from '../../config/logger';
import * as Y from 'yjs';
import { upsertAutoVersion } from '../history/history.service';
import { onTextChange, onAwareness, resetSession, User } from '../collaboration/changeTracker';
import { onModelChange, seedModel, resetModelSession, modelOf, PlainModel } from '../collaboration/modelTracker';
import { elements as modelElements, edges as modelEdges } from '../collaboration/model.types';
import { appendChangeLog } from '../changelog/changelog.service';
import { notifyConflict, createNotification } from '../notifications/notification.service';
import { ConflictPayload } from '../collaboration/awareness.types';
import { isUuid } from '../../utils/validation';
import { broadcastToSession } from '../../utils/broadcast';
import { settings } from '../../config/settings';

const sessionConnections = new Map<string, Set<WebSocket>>();
// Verbindung (Yjs-Transaktions-origin) → userId, damit die Awareness den Auslöser einer Änderung kennt.
const connUsers = new Map<unknown, string>();

// A2 — Drosselung der Konflikt-Benachrichtigungen pro (Session,Opfer).
const CONFLICT_NOTIFY_THROTTLE_MS = settings.conflict.notifyThrottleMs;
const conflictNotifyAt = new Map<string, number>();

// A1 — lokale Präsenz: ist dieser Nutzer aktuell mit der Session verbunden? (für die „aktiv"-Filterung)
function isUserActive(sessionId: string, userId: string): boolean {
  const conns = sessionConnections.get(sessionId);
  if (!conns) return false;
  for (const c of conns) if (connUsers.get(c) === userId) return true;
  return false;
}

// Sprechende Detail-Zeile für die Konflikt-Notification (Was ist mit dem Inhalt des Opfers passiert).
function conflictDetail(p: ConflictPayload): string {
  const label = (p.how?.before as { label?: string } | undefined)?.label;
  const elName = label ? `„${label}"` : (p.where?.elementId ? 'einen Knoten' : (p.where?.edgeId ? 'eine Kante' : 'ein Element'));
  switch (p.what) {
    case 'node.deleted': return `deinen Knoten ${elName} gelöscht`;
    case 'edge.deleted': return 'deine Kante gelöscht';
    case 'delete':       return 'deinen Inhalt überschrieben/gelöscht';
    default:             return `deine Änderung an ${elName} überschrieben`;
  }
}

// A2 — Konflikt dauerhaft an das Opfer melden (gedrosselt, defensiv) — mit Wer (actor) + Was (detail),
// damit die Glocke einen klaren Hinweis zeigt statt nur „Konflikt erkannt".
function notifyConflictThrottled(sessionId: string, payload: ConflictPayload): void {
  const victimUserId = payload.victim?.userId;
  if (!victimUserId) return;
  const key = `${sessionId}:${victimUserId}`;
  const last = conflictNotifyAt.get(key) ?? 0;
  if (Date.now() - last < CONFLICT_NOTIFY_THROTTLE_MS) return;
  conflictNotifyAt.set(key, Date.now());
  void notifyConflict(victimUserId, sessionId, null, { actor: payload.who?.userId ?? 'Jemand', detail: conflictDetail(payload) });
}

// Load/Publish (Restore, Publish) sind bewusste Komplett-Vorgänge → sie sollen die 45-Sek-Frische-
// Konfliktlogik NICHT auslösen (das ist ausschließlich für Live-Edits). Während `fn` (der Modell-Write)
// läuft, überspringt der Server-Modell-Observer die Konflikt-Erkennung und zieht nur die Diff-Basis nach.
// So sind Laden/Publish und der Live-Edit-Konflikt sauber getrennt: Laden/Publish → nur die
// Lade-/Publish-Meldung, nie ein Frische-Konflikt-Fenster dazu.
const suppressModelChange = new Set<string>();
export function suppressModelDuring(sessionId: string, fn: () => void): void {
  suppressModelChange.add(sessionId);
  try { fn(); } finally { suppressModelChange.delete(sessionId); }
}

// Gemeinsam-Laden (Restore bzw. Publish-replace): der Ziel-Stand ersetzt das Live-Modell in einem
// Rutsch — das ist KEIN Frische-Konflikt wie beim Live-Edit, sondern eine bewusste Komplett-Ersetzung.
// (1) Diff-Basis auf den Ziel-Stand seeden → der anschließende FE-Write feuert keinen Fehlalarm-Konflikt.
// (2) Alle ANDEREN verbundenen Nutzer — auch die im Privatmodus! — über den bestehenden Notification-
//     Kanal (Glocke) informieren, dass der gemeinsame Stand durch ein Laden von actorUserId geändert
//     wurde. Wer gerade GEMEINSAM arbeitet, bekommt zusätzlich den Dialog (FE, via `history.restored`).
export function seedAndNotifyLoad(sessionId: string, actorUserId: string, targetModel: PlainModel, detail: string): void {
  seedModel(sessionId, targetModel);
  // NUR Nutzer im PRIVAT-Modus benachrichtigen: wer GEMEINSAM arbeitet, hat die Änderung live erlebt
  // UND bekommt den Dialog (FE) → für ihn wäre die Glocke redundant. Den Modus liest der Server aus der
  // Awareness (`private`-Flag, vom FE gesetzt); `name` in der Awareness = User-ID. Die Notification trägt
  // Wer (actor) + Was (detail), damit die Glocke einen klaren Hinweis zeigt (Restore vs. Publish/merge/replace).
  const ydoc = yjsDocs.get(sessionId);
  const aw = (ydoc as unknown as { awareness?: { getStates?: () => Map<number, { name?: string; private?: boolean }> } })?.awareness;
  const states = aw?.getStates?.();
  if (!states) return;
  const notified = new Set<string>();
  for (const [, state] of states) {
    const uid = state?.name;
    if (!uid || uid === actorUserId || state?.private !== true || notified.has(uid)) continue;
    notified.add(uid);
    void createNotification(uid, sessionId, 'load', null, { actor: actorUserId, detail })
      .catch(() => { /* Notification darf den Vorgang nie stören */ });
  }
}

// Autor-Auflösung für Schicht 2: Yjs-ClientID → echter Nutzer (aus der Awareness), sonst die ClientID als Fallback.
function authorOf(ydoc: Y.Doc, yjsClientId: number): User {
  const aw = (ydoc as unknown as { awareness?: { getStates?: () => Map<number, { user?: { id?: string; name?: string } }> } }).awareness;
  const user = aw?.getStates?.().get(yjsClientId)?.user;
  return user?.id ? { userId: String(user.id), name: user.name } : { userId: String(yjsClientId) };
}
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
let wss: WebSocketServer | null = null;

// ── Kanal 2 (M10/2-Kanäle) — separater WS-Kanal NUR für JSON-Events ────────────
// /sync/:id   = reiner Yjs-BINÄR-Kanal (y-websocket) — trägt KEINE JSON-Frames mehr.
// /events/:id = reiner JSON-Kanal: session.role + alle WS-Events (comment.*, review.*,
//               change_awareness, semantic_conflict, history.*, draft.*, task.*, chat.*).
// So sieht der y-websocket-Client keine Text-Frames mehr → kein Decoding-Fehler mehr.
let eventWss: WebSocketServer | null = null;
const eventConnections = new Map<string, Set<WebSocket>>();
const eventConnUsers = new Map<unknown, string>();

// Redis-Subscription pro Session referenzzählen — Sync- UND Event-Sockets halten sie am Leben.
// Aufruf VOR dem Hinzufügen des Sockets (subscribe bei erstem), NACH dem Entfernen (unsubscribe bei letztem).
function subscribeSession(sessionId: string): void {
  const total = (sessionConnections.get(sessionId)?.size ?? 0) + (eventConnections.get(sessionId)?.size ?? 0);
  if (total === 0) {
    subscriber.subscribe(`session:${sessionId}:events`)
      .catch((err) => logger.error({ err, sessionId }, '[Pub/Sub] Subscribe Fehler'));
  }
}
function unsubscribeSessionIfIdle(sessionId: string): void {
  const total = (sessionConnections.get(sessionId)?.size ?? 0) + (eventConnections.get(sessionId)?.size ?? 0);
  if (total === 0) {
    subscriber.unsubscribe(`session:${sessionId}:events`)
      .catch((err) => logger.error({ err, sessionId }, '[Pub/Sub] Unsubscribe Fehler'));
  }
}

const DEBOUNCE_MS = settings.save.debounceMs;

// ── "Aktuell geladen" — sessionweite Markierung, welche History-Version dem geteilten
// Live-Canvas gerade entspricht ──────────────────────────────────────────────────────
// Rein flüchtiger In-Memory-Zustand (wie yjsDocs/saveTimers) — keine Persistenz nötig, nach
// einem Neustart oder wenn die letzte Verbindung getrennt wird, setzt der nächste
// Save/Update/Restore die Markierung einfach neu.
const activeVersionBySession = new Map<string, string | null>();

// Kurzes, gezieltes Unterdrückungsfenster NUR für Restore: das FE schreibt das Zielmodell direkt
// im Anschluss per eigenem ydoc.transact() ins geteilte Doc. Diese Schreibaktion feuert dieselben
// Model-Change-Observer (Zeile ~180 unten), die sonst "Live-Canvas hat sich geändert → Markierung
// löschen" auslösen — ohne dieses Fenster würde Restore seine eigene, gerade gesetzte Markierung
// im selben Atemzug wieder zunichtemachen. 2s reichen für die Yjs-Update-Relais-Laufzeit deutlich.
const RESTORE_SUPPRESS_MS = 2_000;
const restoreSuppressUntil = new Map<string, number>();

export function getActiveVersion(sessionId: string): string | null {
  return activeVersionBySession.get(sessionId) ?? null;
}

// Nach erfolgreichem Save/Update/Restore aufrufen: setzt die Markierung UND broadcastet sie an
// ALLE Tabs (auch den auslösenden) — niemals nur lokal im Frontend setzen, sonst können zwei Tabs
// wieder unterschiedliche Stände als "aktuell geladen" zeigen (genau der ursprüngliche Bug).
export function setActiveVersion(sessionId: string, versionId: string | null): void {
  activeVersionBySession.set(sessionId, versionId);
  broadcastToSession(sessionId, { type: 'history.active_version', payload: { version_id: versionId } });
}

// VOR dem Restore-Response aufrufen (siehe history/routes.ts): blendet die durch das gleich
// folgende Yjs-Write des Ziel-Modells ausgelöste Invalidierung für ein kurzes Fenster aus.
export function suppressActiveVersionInvalidation(sessionId: string): void {
  restoreSuppressUntil.set(sessionId, Date.now() + RESTORE_SUPPRESS_MS);
}

// Wird bei JEDER echten Modell-Mutation aufgerufen (Observer unten). Löscht die Markierung für
// alle, außer wir befinden uns gerade im kurzen Restore-Unterdrückungsfenster.
function invalidateActiveVersionOnModelChange(sessionId: string): void {
  if (activeVersionBySession.get(sessionId) == null) return; // nichts markiert — nichts zu tun
  const suppressUntil = restoreSuppressUntil.get(sessionId);
  if (suppressUntil && Date.now() < suppressUntil) return; // eigene Restore-Schreibaktion — ignorieren
  setActiveVersion(sessionId, null);
}
const REDIS_SNAPSHOT_TTL = settings.save.redisSnapshotTtlSeconds; // Default 24 h

// Präsenzverwaltung (M22): TTL in Sekunden, Heartbeat-Intervall in Millisekunden.
// Invariante: HEARTBEAT_INTERVAL < (PRESENCE_TTL * 1000) / 2
const PRESENCE_TTL = 30;
const HEARTBEAT_INTERVAL = 10_000;

// N3 — WebSocket-Abuse-Schutz (env-konfigurierbar): Verbindungslimit pro Nutzer + max. Frame-Größe.
const WS_MAX_CONN_PER_USER = settings.ws.maxConnPerUser;
const WS_MAX_PAYLOAD = settings.ws.maxPayloadBytes; // Default 5 MB
const userConnections = new Map<string, number>();

// N6 — Save-Listener-Tracking ohne Monkey-Patch am Y.Doc (GC-freundlich via WeakSet).
const docsWithSaveListener = new WeakSet<Y.Doc>();

// ── Horizontale Skalierung: Redis Pub/Sub ────────────────
// Einmaliger Handler: leitet eingehende Pub/Sub-Nachrichten an lokale WebSocket-Clients weiter.
// Jede Server-Instanz empfängt so Broadcasts anderer Instanzen für ihre lokalen Clients.
subscriber.on('message', (channel: string, message: string) => {
  const match = channel.match(/^session:(.+):events$/);
  if (!match) return;
  const sessionId = match[1];
  // JSON-Events gehen NUR an den Event-Kanal (nicht mehr an die Yjs-Sync-Sockets).
  const connections = eventConnections.get(sessionId);
  if (!connections) return;
  connections.forEach((ws) => {
    if (ws.readyState === ws.OPEN) ws.send(message);
  });
});

// ── Snapshot-Persistenz (eine Quelle) ───────────────────
// Kodiert den Yjs-Stand und schreibt ihn nach Redis (Cache) + PostgreSQL (dauerhaft).
// UPSERT, damit auch eine erstmals genutzte Session (noch kein documents-Eintrag)
// korrekt gespeichert wird (reines UPDATE träfe 0 Zeilen).
// bumpVersion=true erhöht documents.version — nur für den finalen writeState-Snapshot
// beim Trennen der letzten Verbindung; laufende Saves (Debounce, Shutdown-Flush) lassen
// die Version unverändert. Wirft bei Fehlern — der Aufrufer loggt kontextspezifisch.
async function persistSnapshot(sessionId: string, ydoc: Y.Doc, bumpVersion = false): Promise<void> {
  const snapshot = Buffer.from(Y.encodeStateAsUpdate(ydoc));
  await Promise.all([
    redis.set(`session:${sessionId}:snapshot`, snapshot, 'EX', REDIS_SNAPSHOT_TTL),
    db.query(
      `INSERT INTO documents (session_id, content_snapshot, version, updated_at)
       VALUES ($1, $2, 1, NOW())
       ON CONFLICT (session_id) DO UPDATE
         SET content_snapshot = EXCLUDED.content_snapshot,
             version          = ${bumpVersion ? 'documents.version + 1' : 'documents.version'},
             updated_at       = NOW()`,
      [sessionId, snapshot]
    ),
  ]);
}

// ── M6 — Persistenz einrichten ──────────────────────────
setPersistence({
  provider: null,

  // Dokument laden: erst Redis (< 1ms), dann PostgreSQL als Fallback
  bindState: async (sessionId: string, ydoc: Y.Doc) => {
    try {
      const cached = await redis.getBuffer(`session:${sessionId}:snapshot`);
      if (cached) {
        Y.applyUpdate(ydoc, cached);
        logger.info({ sessionId }, '[M6] Snapshot aus Redis geladen');
      } else {
        // Fallback: PostgreSQL (z.B. nach Server-Neustart wenn Redis leer ist)
        const result = await db.query(
          `SELECT content_snapshot FROM documents WHERE session_id = $1`,
          [sessionId]
        );
        if (result.rows[0]?.content_snapshot) {
          const snapshot: Buffer = result.rows[0].content_snapshot;
          Y.applyUpdate(ydoc, snapshot);
          // Für den nächsten Reconnect in Redis cachen
          await redis.set(`session:${sessionId}:snapshot`, snapshot, 'EX', REDIS_SNAPSHOT_TTL);
          logger.info({ sessionId }, '[M6] Snapshot aus PostgreSQL geladen + gecacht');
        } else {
          logger.info({ sessionId }, '[M6] Kein Snapshot — neues Dokument');
        }
      }
    } catch (err) {
      logger.error({ err, sessionId }, '[M6] Laden Fehler');
    }

    // Debounce: erst 5s (DEBOUNCE_MS) nach der letzten Änderung speichern.
    // Solange jemand tippt, wird der Timer zurückgesetzt → 1 Write statt 1 pro Tastendruck.
    // PERF: Guard — verhindert mehrfache Listener falls bindState für dieselbe ydoc-Instanz
    // mehrfach aufgerufen wird (z.B. bei parallelen Verbindungen).
    if (docsWithSaveListener.has(ydoc)) return;
    docsWithSaveListener.add(ydoc);

    // Change/Conflict-Awareness (Schicht 2) — Regel B+C über den Text-Delta, Regel A über die Awareness.
    // Vollständig defensiv: Awareness darf den Sync/Save niemals stören.
    ydoc.getText('content').observe((event) => {
      try {
        const ctx = {
          actorUserId: connUsers.get(event.transaction.origin) ?? null,
          authorOf: (c: number) => authorOf(ydoc, c),
          isActive: (uid: string) => isUserActive(sessionId, uid), // A1: nur aktive Opfer flaggen
        };
        for (const ev of onTextChange(sessionId, event, ctx)) {
          broadcastToSession(sessionId, ev);
          void appendChangeLog(sessionId, ev); // Punkt 3: persistenter, nachlesbarer Feed
          if (ev.type === 'semantic_conflict') notifyConflictThrottled(sessionId, ev.payload); // A2
        }
      } catch (err) {
        logger.error({ err, sessionId }, '[Awareness] text-observe Fehler (ignoriert)');
      }
    });
    // Schicht 2 fürs MODELL (M11): Erkennung über Snapshot-Diff des Plain-Modells
    // (liefert how.before + edgeId verlässlich). Vollständig defensiv (stört Sync/Save nie).
    const handleModel = (origin: unknown): void => {
      try {
        if (suppressModelChange.has(sessionId)) {
          // Laufender Load/Publish → KEINE Frische-Konflikte; nur die Diff-Basis auf den neuen Stand
          // ziehen, damit spätere Live-Edits wieder korrekt gegen den aktuellen Stand geprüft werden.
          seedModel(sessionId, modelOf(ydoc));
        } else {
          const ctx = { actorUserId: connUsers.get(origin) ?? null, isActive: (uid: string) => isUserActive(sessionId, uid) };
          for (const ev of onModelChange(sessionId, ctx, modelOf(ydoc))) {
            broadcastToSession(sessionId, ev);
            void appendChangeLog(sessionId, ev);
            if (ev.type === 'semantic_conflict') notifyConflictThrottled(sessionId, ev.payload);
          }
        }
      } catch (err) {
        logger.error({ err, sessionId }, '[Awareness] model-observe Fehler (ignoriert)');
      }
      // "Aktuell geladen" invalidieren: jede echte Modell-Mutation bedeutet, dass der Live-Canvas
      // (außerhalb des kurzen Restore-Unterdrückungsfensters) nicht mehr exakt der zuletzt
      // markierten Version entspricht. Eigener try/catch: darf Sync/Save nie stören.
      try {
        invalidateActiveVersionOnModelChange(sessionId);
      } catch (err) {
        logger.error({ err, sessionId }, '[History] active-version Invalidierung Fehler (ignoriert)');
      }
    };
    // Basis-Stand setzen, damit bereits geladene Knoten/Kanten nicht als „neu" gemeldet werden.
    seedModel(sessionId, modelOf(ydoc));
    modelElements(ydoc).observeDeep((_events, txn) => handleModel(txn.origin));
    modelEdges(ydoc).observeDeep((_events, txn) => handleModel(txn.origin));

    const awareness = (ydoc as unknown as { awareness?: { on?: (e: string, cb: () => void) => void; getStates?: () => Map<number, unknown> } }).awareness;
    if (awareness?.on && awareness.getStates) {
      awareness.on('update', () => {
        try {
          const states = awareness.getStates!();
          for (const ev of onAwareness(sessionId, states)) {
            broadcastToSession(sessionId, ev);
            void appendChangeLog(sessionId, ev); // Punkt 3
          }
        } catch { /* defensiv */ }
      });
    }

    ydoc.on('update', () => {
      const existing = saveTimers.get(sessionId);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(async () => {
        try {
          await persistSnapshot(sessionId, ydoc);
          logger.info({ sessionId }, '[M6] Debounce-Snapshot gespeichert');
        } catch (err) {
          logger.error({ err, sessionId }, '[M6] Debounce-Snapshot Fehler');
        } finally {
          saveTimers.delete(sessionId);
        }
      }, DEBOUNCE_MS);

      saveTimers.set(sessionId, timer);
    });
  },

  // Letzter Snapshot wenn die letzte Verbindung einer Session getrennt wird
  writeState: async (sessionId: string, ydoc: Y.Doc) => {
    try {
      await persistSnapshot(sessionId, ydoc, true); // finaler Snapshot erhöht die Version
      logger.info({ sessionId }, '[M6] Finaler Snapshot gespeichert');
    } catch (err) {
      logger.error({ err, sessionId }, '[M6] Speichern Fehler');
    }

    // M7: Geteilter Auto-Stand „letzter Session-Stand" beim Disconnect des letzten Nutzers.
    // 'system' als Autor (server-seitig ausgelöst); genau EINER je Session (Upsert statt Anhäufen).
    try {
      const textContent = ydoc.getText('content').toString();
      await upsertAutoVersion(sessionId, 'system', textContent, 'session', modelOf(ydoc));
      logger.info({ sessionId }, '[M7] Geteilter Auto-Stand aktualisiert');
    } catch (err) {
      logger.error({ err, sessionId }, '[M7] Auto-Stand Fehler');
    }

    // "Aktuell geladen" ist reiner Live-Zustand der laufenden ydoc-Instanz — beim Wegräumen der
    // letzten Verbindung mit aufräumen, statt einen möglicherweise nicht mehr zutreffenden Stand
    // über einen Reconnect hinweg mitzuschleppen. Der nächste Save/Update/Restore setzt neu.
    activeVersionBySession.delete(sessionId);
    restoreSuppressUntil.delete(sessionId);
  },
});

// Gemeinsame Upgrade-Prüfung für /sync UND /events: Session existiert? Token/Dev-Rolle gültig?
// Mitglied? Rolle auflösen. Setzt authUserId/authUserName/sessionRole am request. false = ablehnen.
async function resolveWsUpgrade(request: IncomingMessage, sessionId: string): Promise<boolean> {
  if (!isUuid(sessionId)) {
    logger.warn({ sessionId }, '[WS] Ungültige Session-ID — abgelehnt');
    return false;
  }
  try {
    const result = await db.query('SELECT id FROM sessions WHERE id = $1', [sessionId]);
    if (result.rows.length === 0) {
      logger.warn({ sessionId }, '[WS] Session nicht gefunden — abgelehnt');
      return false;
    }
  } catch {
    return false;
  }

  const serviceUrl = process.env.AUTH_SERVICE_URL;
  if (serviceUrl) {
    const urlParams = new URL(request.url ?? '', 'http://localhost');
    const token = urlParams.searchParams.get('token');
    if (!token) return false;
    const user = await validateToken(token, serviceUrl);
    if (!user) return false;
    (request as IncomingMessage & { authUserId?: string; authUserName?: string }).authUserId = user.id;
    (request as IncomingMessage & { authUserName?: string }).authUserName = user.name;
    try {
      if (!await checkSessionMembership(user.id, sessionId)) {
        logger.warn({ sessionId, userId: user.id }, '[WS] N1: Kein Mitglied — abgelehnt');
        return false;
      }
      (request as IncomingMessage & { sessionRole?: SessionRole }).sessionRole =
        (await getSessionRole(user.id, sessionId)) ?? undefined;
    } catch {
      return false;
    }
  } else if (devEnforcesRoles()) {
    // Dev-only: lokales Multi-Rollen-Testen ohne echten Auth-Service (Query-Param devUser,
    // weil Browser-WebSockets keine Custom-Header setzen können).
    const urlParams = new URL(request.url ?? '', 'http://localhost');
    const userId = urlParams.searchParams.get('devUser') || 'dev-user';
    (request as IncomingMessage & { authUserId?: string }).authUserId = userId;
    try {
      if (!await checkSessionMembership(userId, sessionId)) {
        logger.warn({ sessionId, userId }, '[WS] Dev-Rollen-Test: Kein Mitglied — abgelehnt');
        return false;
      }
      (request as IncomingMessage & { sessionRole?: SessionRole }).sessionRole =
        (await getSessionRole(userId, sessionId)) ?? undefined;
    } catch {
      return false;
    }
  }
  return true;
}

export function setupWebSocketServer(server: Server): void {
  const localWss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
  wss = localWss;
  // Zweiter WS-Server (noServer) für den reinen JSON-Event-Kanal /events.
  const localEventWss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
  eventWss = localEventWss;

  // ── Upgrade: /sync = Yjs-Binärkanal, /events = JSON-Event-Kanal (M10/2-Kanäle) ─
  server.on('upgrade', async (request, socket, head) => {
    const url = request.url ?? '';
    const isSync = url.startsWith('/sync/');
    const isEvents = url.startsWith('/events/');
    if (!isSync && !isEvents) {
      socket.destroy();
      return;
    }

    const prefix = isSync ? '/sync/' : '/events/';
    const sessionId = url.slice(prefix.length).replace(/\?.*$/, '');

    // Gleiche Auth/Rollen-Auflösung für beide Kanäle (UUID + Session-Existenz + Token/Rolle).
    if (!(await resolveWsUpgrade(request, sessionId))) {
      socket.destroy();
      return;
    }
    (request as typeof request & { sessionId?: string }).sessionId = sessionId;

    const target = isSync ? localWss : localEventWss;
    target.handleUpgrade(request, socket, head, (ws) => {
      target.emit('connection', ws, request);
    });
  });

  localWss.on('connection', (ws, request) => {
    const augmented = request as typeof request & { authUserId?: string; sessionId?: string };
    const sessionId = augmented.sessionId ?? 'unknown';
    const authRequest = request as typeof request & { authUserId?: string };
    const userId = authRequest.authUserId ?? 'dev-user';

    // N3: Verbindungslimit pro Nutzer (Abuse-/DoS-Schutz). Bei Überschreitung wird die Verbindung geschlossen.
    const openForUser = userConnections.get(userId) ?? 0;
    if (openForUser >= WS_MAX_CONN_PER_USER) {
      logger.warn({ sessionId, userId, open: openForUser }, '[WS] Verbindungslimit erreicht — abgelehnt');
      ws.close(1008, 'connection limit reached');
      return;
    }
    userConnections.set(userId, openForUser + 1);
    connUsers.set(ws, userId); // für Schicht 2: Auslöser einer Änderung (tr.origin) auflösen

    const connId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const presenceKey = `presence:${sessionId}:${userId}:${connId}`;

    logger.info({ sessionId, userId, connId }, '[WS] connect');

    subscribeSession(sessionId); // VOR dem Hinzufügen (subscribe nur bei erster Verbindung der Session)
    if (!sessionConnections.has(sessionId)) sessionConnections.set(sessionId, new Set());
    sessionConnections.get(sessionId)?.add(ws);

    redis.set(presenceKey, '1', 'EX', PRESENCE_TTL)
      .then(() => logger.info({ sessionId, userId, connId }, '[Presence] Key gesetzt'))
      .catch((err) => logger.error({ err, sessionId }, '[Presence] Key Fehler'));

    const heartbeat = setInterval(() => {
      redis.set(presenceKey, '1', 'EX', PRESENCE_TTL)
        .catch((err) => logger.error({ err, sessionId }, '[Presence] Heartbeat Fehler'));
    }, HEARTBEAT_INTERVAL);

    // N1 (Rollen): Editierrecht bestimmen.
    // Dev-Modus (kein AUTH_SERVICE_URL, kein DEV_ENFORCE_ROLES): immer volle Rechte.
    const role = (request as typeof request & { sessionRole?: SessionRole }).sessionRole;
    const canEdit = (!process.env.AUTH_SERVICE_URL && !devEnforcesRoles()) || role === 'owner' || role === 'member';

    // /sync ist ein REINER Yjs-Binärkanal (M10/2-Kanäle) — hier werden KEINE JSON-Frames mehr
    // gesendet. session.role + alle WS-Events laufen über den separaten /events-Kanal (unten).
    if (canEdit) {
      setupWSConnection(ws, request, { docName: sessionId, gc: true });
    } else {
      // spectator/commentator: lesen + Awareness ja, aber eingehende Yjs-Schreib-Updates werden verworfen.
      setupReadonlyConnection(ws, request, sessionId);
    }

    ws.on('close', () => {
      // Persönlicher Auto-Stand „mein letzter Stand": bei JEDEM Disconnect den aktuellen
      // Dokumentstand für diesen Nutzer sichern (genau einer, Upsert). Schützt vor fremdem
      // Überschreiben/Löschen, während man weg ist. Defensiv: stört den Disconnect nie.
      try {
        const liveDoc = yjsDocs.get(sessionId);
        if (liveDoc) {
          const content = liveDoc.getText('content').toString();
          // Text UND Modell sichern (der Service überspringt, wenn beides leer ist).
          void upsertAutoVersion(sessionId, userId, content, 'personal', modelOf(liveDoc))
            .catch((err) => logger.error({ err, sessionId, userId }, '[History] persönlicher Auto-Stand Fehler'));
        }
      } catch { /* defensiv */ }

      // N3: Nutzer-Verbindungszähler dekrementieren
      const left = (userConnections.get(userId) ?? 1) - 1;
      if (left <= 0) userConnections.delete(userId);
      else userConnections.set(userId, left);

      clearInterval(heartbeat);
      connUsers.delete(ws);
      redis.del(presenceKey)
        .then(() => logger.info({ sessionId, userId, connId }, '[Presence] Key gelöscht'))
        .catch((err) => logger.error({ err, sessionId }, '[Presence] Key löschen Fehler'));

      sessionConnections.get(sessionId)?.delete(ws);
      if (sessionConnections.get(sessionId)?.size === 0) {
        // Letzte Sync-Verbindung weg: Debounce-Timer canceln (writeState übernimmt den finalen Save).
        const pendingTimer = saveTimers.get(sessionId);
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          saveTimers.delete(sessionId);
        }
        sessionConnections.delete(sessionId);
        resetSession(sessionId);      // Schicht-2-Zustand (Text) aufräumen
        resetModelSession(sessionId); // Schicht-2-Zustand (Modell) aufräumen
      }
      // Pub/Sub erst abbestellen, wenn AUCH kein Event-Socket der Session mehr offen ist.
      unsubscribeSessionIfIdle(sessionId);
      logger.info({ sessionId, userId }, '[WS] disconnect');
    });
  });

  // ── /events-Kanal: reine JSON-Events (session.role + alle WS-Events) ─────────
  localEventWss.on('connection', (ws, request) => {
    const augmented = request as typeof request & { authUserId?: string; sessionId?: string; sessionRole?: SessionRole };
    const sessionId = augmented.sessionId ?? 'unknown';
    const userId = augmented.authUserId ?? 'dev-user';
    const role = augmented.sessionRole;
    const canEdit = (!process.env.AUTH_SERVICE_URL && !devEnforcesRoles()) || role === 'owner' || role === 'member';

    subscribeSession(sessionId); // VOR dem Hinzufügen
    if (!eventConnections.has(sessionId)) eventConnections.set(sessionId, new Set());
    eventConnections.get(sessionId)?.add(ws);
    eventConnUsers.set(ws, userId);
    logger.info({ sessionId, userId }, '[WS/events] connect');

    // Reiner JSON-Kanal → session.role darf sofort der erste Frame sein (kein Yjs-Handshake-Konflikt).
    ws.send(JSON.stringify({
      type: 'session.role',
      payload: { role: role ?? 'owner', can_edit: canEdit, active_version_id: getActiveVersion(sessionId) },
    }));

    ws.on('close', () => {
      eventConnections.get(sessionId)?.delete(ws);
      if (eventConnections.get(sessionId)?.size === 0) eventConnections.delete(sessionId);
      eventConnUsers.delete(ws);
      unsubscribeSessionIfIdle(sessionId);
      logger.info({ sessionId, userId }, '[WS/events] disconnect');
    });
  });
}

// broadcastToSession liegt jetzt in utils/broadcast (entkoppelt die Services vom WS-Controller).
// Re-Export, damit bestehende Importe aus diesem Modul weiter funktionieren.
export { broadcastToSession };

// Rolle/Mitgliedschaft wird nur einmal beim WS-Connect aufgelöst (sessionRole am Upgrade-Request).
// Ändert der Owner die Rolle eines bereits verbundenen Mitglieds (oder entfernt es), merkt die
// offene Verbindung das nicht von selbst — deshalb hier hart trennen, damit der Client automatisch
// neu verbindet und dabei die aktuelle Rolle/Mitgliedschaft frisch auflöst.
export function disconnectUserFromSession(sessionId: string, userId: string): void {
  const conns = sessionConnections.get(sessionId);
  if (conns) {
    for (const ws of conns) {
      if (connUsers.get(ws) === userId) ws.close(4001, 'role-changed');
    }
  }
  // Auch den Event-Kanal des Nutzers trennen → beim Reconnect wird die neue Rolle frisch aufgelöst.
  const evts = eventConnections.get(sessionId);
  if (evts) {
    for (const ws of evts) {
      if (eventConnUsers.get(ws) === userId) ws.close(4001, 'role-changed');
    }
  }
}

// Rollenwechsel eines BEREITS VERBUNDENEN Mitglieds sofort wirksam machen, ohne den /events-Kanal zu
// kappen — robuster als „beide Kanäle trennen und auf den (flakigen) Reconnect hoffen":
//  1) Frische Rolle direkt über den OFFENEN /events-Socket pushen → das FE setzt canEdit/Canvas live,
//     unabhängig davon, ob/wann der /sync-Provider neu verbindet.
//  2) NUR den /sync-Socket schließen → er verbindet neu und löst dabei die serverseitige Schreib-Sperre
//     (writable ↔ readonly) frisch auf. Ohne das bliebe ein degradierter Member auf seinem alten,
//     noch beschreibbaren /sync-Socket und könnte weiter ins geteilte Modell schreiben (Sicherheit).
export async function notifyRoleChange(sessionId: string, userId: string): Promise<void> {
  const role = await getSessionRole(userId, sessionId);
  const canEdit = (!process.env.AUTH_SERVICE_URL && !devEnforcesRoles()) || role === 'owner' || role === 'member';
  const frame = JSON.stringify({
    type: 'session.role',
    payload: { role: role ?? 'owner', can_edit: canEdit, active_version_id: getActiveVersion(sessionId) },
  });
  // (1) Live-Push über den offenen /events-Socket des Nutzers (nicht schließen).
  const evts = eventConnections.get(sessionId);
  if (evts) {
    for (const ws of evts) {
      if (eventConnUsers.get(ws) === userId && ws.readyState === ws.OPEN) ws.send(frame);
    }
  }
  // (2) Nur /sync trennen → Reconnect löst writable/readonly neu auf.
  const conns = sessionConnections.get(sessionId);
  if (conns) {
    for (const ws of conns) {
      if (connUsers.get(ws) === userId) ws.close(4001, 'role-changed');
    }
  }
}

// Auto-Sicherung des aktuellen geteilten Live-Stands (Text + Modell) in einen benannten Session-
// Auto-Slot — für Restore/Veröffentlichen, damit beides immer rückholbar ist. Tut nichts, wenn
// das Doc gerade nicht geladen ist (niemand verbunden → kein „aktueller" Stand zu schützen).
export async function buildPreSnapshot(sessionId: string, name: string, author: string): Promise<void> {
  const liveDoc = yjsDocs.get(sessionId);
  if (!liveDoc) return;
  const content = liveDoc.getText('content').toString();
  await upsertAutoVersion(sessionId, author, content, 'session', modelOf(liveDoc), name);
}

// Schließt alle offenen WebSocket-Verbindungen und den WebSocket-Server.
// Muss vor httpServer.close() aufgerufen werden — sonst wartet httpServer.close()
// ewig auf das Ende der lang-lebigen WS-Verbindungen und der Callback feuert nie.
export async function closeWebSocketServer(): Promise<void> {
  if (!wss) return;

  // Laufende Debounce-Timer abbrechen — der finale Snapshot wird unten explizit geschrieben,
  // damit kein Inhalt verloren geht (Timer würden sonst einfach gecancelt ohne Save).
  saveTimers.forEach((timer) => clearTimeout(timer));
  saveTimers.clear();

  // Alle aktiven Sessions persistieren BEVOR die Verbindungen getrennt werden.
  const flushPromises: Promise<void>[] = [];
  for (const [sessionId] of sessionConnections) {
    const ydoc = yjsDocs.get(sessionId);
    if (!ydoc) continue;

    flushPromises.push(
      (async () => {
        try {
          await persistSnapshot(sessionId, ydoc);
          logger.info({ sessionId }, '[Shutdown] Snapshot gespeichert');
        } catch (err) {
          logger.error({ err, sessionId }, '[Shutdown] Snapshot-Fehler');
        }
      })()
    );
  }

  if (flushPromises.length > 0) {
    await Promise.allSettled(flushPromises);
    logger.info(`[Shutdown] ${flushPromises.length} Session(s) gespeichert`);
  }

  // Jetzt alle Verbindungen trennen (Sync- UND Event-Kanal)
  sessionConnections.forEach((clients) => {
    clients.forEach((ws) => ws.terminate());
  });
  sessionConnections.clear();
  eventConnections.forEach((clients) => {
    clients.forEach((ws) => ws.terminate());
  });
  eventConnections.clear();
  if (eventWss) { eventWss.close(); eventWss = null; }

  return new Promise((resolve) => {
    wss!.close(() => {
      logger.info('[Shutdown] WebSocket-Server geschlossen');
      resolve();
    });
  });
}

export function getActiveSessionCount(): number {
  return sessionConnections.size;
}

export function getActiveWsConnectionCount(): number {
  let count = 0;
  sessionConnections.forEach((clients) => { count += clients.size; });
  return count;
}