import { Router, Request, Response, NextFunction } from 'express';
import { sendError } from '../../utils/http';
import {
    createVersion, getHistory, getVersion,
    listByScope, countManual, getVersionById, deleteVersionById, renameVersion, updateVersion,
    upsertAutoVersion,
    SESSION_MANUAL_LIMIT, PERSONAL_MANUAL_LIMIT, HistoryScope,
} from './history.service';
import { PlainModelJson } from '../../types/model';
import { requireSessionMember, ensureModelEditor, checkSessionOwner, requireModelEditor } from '../../middleware/authorization';
import { requireUuidParam } from '../../middleware/validateParams';
import { docs as yjsDocs } from 'y-websocket/bin/utils';
import { modelOf, PlainModel } from '../collaboration/modelTracker';
import { broadcastToSession } from '../../utils/broadcast';
import { setActiveVersion, suppressActiveVersionInvalidation, seedAndNotifyLoad } from '../websocket/controller';

export const historyRoutes = Router();

// GET    /sessions/:id/history[?scope=session|personal] – Stände auflisten (Eimer-gefiltert)
// POST   /sessions/:id/history { content, name?, scope? } – Stand bewusst speichern (409 wenn Eimer voll)
// DELETE /history/:versionId                            – Stand gezielt löschen
// PATCH  /history/:versionId { name }                   – Stand umbenennen
// PATCH  /history/:versionId { content?, model_json? }  – Inhalt atomar aktualisieren (id/version_number bleiben)

historyRoutes.get('/sessions/:id/history', requireSessionMember, async (req: Request, res: Response, next: NextFunction) => {
    const sessionId = req.params.id;
    const scope = req.query.scope;

    try {
        // Eimer-gefilterte Liste: 'personal' nur die eigenen, 'session' die geteilten.
        if (scope === 'personal') {
            res.json(await listByScope(sessionId, 'personal', req.user!.id));
            return;
        }
        if (scope === 'session') {
            res.json(await listByScope(sessionId, 'session'));
            return;
        }

        // Ohne scope: kompletter Verlauf (abwärtskompatibel, paginiert).
        const MAX_LIMIT = 200;
        const limit  = req.query.limit  !== undefined ? Number(req.query.limit)  : 50;
        const offset = req.query.offset !== undefined ? Number(req.query.offset) : 0;
        if (Number.isNaN(limit) || Number.isNaN(offset) || limit < 1 || offset < 0 || limit > MAX_LIMIT) {
            sendError(res, 400, `limit muss zwischen 1 und ${MAX_LIMIT} liegen, offset muss ≥ 0 sein`);
            return;
        }
        res.json(await getHistory(sessionId, limit, offset));
    } catch (err) {
        next(err);
    }
});

// Stand wiederherstellen — owner ODER member (das geteilte Live-Doc betrifft alle, daher
// dieselbe Rechteschwelle wie normales Modell-Bearbeiten, nicht owner-exklusiv: sonst könnten
// Member tagelang nicht auf einen besseren alten Stand zurück, wenn der Owner gerade nicht da ist).
// Sichert vorher automatisch den aktuellen Stand (uncounted Auto-Slot „Stand vor Wiederherstellung"),
// broadcastet das Ereignis und liefert den Ziel-Stand zurück; das FE spielt content + model_json ein.
historyRoutes.post('/sessions/:id/history/:version/restore', requireModelEditor, async (req: Request, res: Response, next: NextFunction) => {
    const sessionId     = req.params.id;
    const versionNumber = Number(req.params.version);

    if (Number.isNaN(versionNumber)) {
        sendError(res, 400, 'Version muss eine gültige Zahl sein');
        return;
    }

    try {
        const target = await getVersion(sessionId, versionNumber);
        if (!target) {
            sendError(res, 404, 'Version nicht gefunden');
            return;
        }

        // Auto-Sicherung des aktuellen Live-Stands (falls jemand verbunden ist) → Restore ist
        // immer rückholbar. Eigener Auto-Slot (author 'system:pre-restore'), zählt nicht zum Limit.
        const liveDoc = yjsDocs?.get?.(sessionId);
        if (liveDoc) {
            const content = liveDoc.getText('content').toString();
            await upsertAutoVersion(sessionId, 'system:pre-restore', content, 'session', modelOf(liveDoc), 'Stand vor Wiederherstellung');
        }

        // Sprechendes Label des geladenen Stands (Name aus „Stand speichern", sonst Fallback) — für die
        // Notification (Wer/Was) und den Dialog/Toast.
        const versionLabel = target.name || (target.kind === 'auto' ? 'Auto-Stand' : `Version ${target.version_number}`);

        // Gemeinsam-Laden: Diff-Basis auf den Zielstand seeden (kein Fehlalarm-Konflikt beim FE-Write)
        // UND die PRIVAT arbeitenden anderen Nutzer über die Glocke informieren (mit Wer + Was). Wer
        // gerade GEMEINSAM arbeitet, bekommt stattdessen den Dialog (FE, via `history.restored`).
        seedAndNotifyLoad(sessionId, req.user!.id, (target.model_json as PlainModel | null) ?? { nodes: [], edges: [] }, `„${versionLabel}" in den gemeinsamen Stand geladen`);

        // Unterdrückungsfenster VOR setActiveVersion setzen: das FE schreibt das Zielmodell direkt
        // im Anschluss per eigenem ydoc.transact() ins geteilte Doc — das feuert sonst sofort die
        // Model-Change-Invalidierung und würde die hier gesetzte Markierung im selben Moment wieder
        // löschen (Restore würde seine eigene "aktuell geladen"-Markierung selbst zunichtemachen).
        suppressActiveVersionInvalidation(sessionId);
        setActiveVersion(sessionId, target.id);

        // Allen mitteilen, dass zurückgesetzt wird (Transparenz: wer, auf welchen Stand).
        broadcastToSession(sessionId, { type: 'history.restored', payload: { version: versionNumber, by: req.user!.id, name: versionLabel } });

        // Das FE (owner-Client) spielt content + model_json in das geteilte Doc ein.
        res.json(target);
    } catch (err) {
        next(err);
    }
});

// Bewusst einen Stand speichern. scope='session' (geteilt, Editor-Recht) oder 'personal' (eigener, jedes Mitglied).
// Bei vollem Eimer → 409 (kein stilles Prune): erst löschen, dann speichern.
historyRoutes.post('/sessions/:id/history', requireSessionMember, async (req: Request, res: Response, next: NextFunction) => {
    const sessionId = req.params.id;
    const content: string = typeof req.body.content === 'string' ? req.body.content : '';
    const name: string = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const scope: HistoryScope = req.body.scope === 'personal' ? 'personal' : 'session';

    if (content.trim().length === 0) {
        sendError(res, 400, 'content darf nicht leer sein');
        return;
    }
    if (name.length === 0) {
        sendError(res, 400, 'name ist ein Pflichtfeld (benannter Stand)');
        return;
    }

    try {
        // Geteilte Stände setzen Editier-Recht voraus; persönliche genügt Mitgliedschaft (oben geprüft).
        if (scope === 'session' && !(await ensureModelEditor(req.user!.id, sessionId, res))) return;

        const limit = scope === 'session' ? SESSION_MANUAL_LIMIT : PERSONAL_MANUAL_LIMIT;
        const used  = await countManual(sessionId, scope, scope === 'personal' ? req.user!.id : undefined);
        if (used >= limit) {
            res.status(409).json({
                error: { message: 'Speicher voll — bitte zuerst einen Stand löschen', status: 409 },
                bucket: scope, limit, used,
            });
            return;
        }

        // Modell (M11): bevorzugt aus dem Request-Body (z. B. ein EIGENER Entwurf/Tab),
        // sonst aus dem geteilten Live-Doc. So lässt sich auch ein privater Entwurfs-Stand
        // sichern und reviewen, nicht nur der geteilte Stand.
        const opts: Parameters<typeof createVersion>[3] = { name, scope, kind: 'manual' };
        const bodyModel = req.body.model_json;
        if (bodyModel !== undefined && bodyModel !== null) {
            if (typeof bodyModel !== 'object' || !Array.isArray(bodyModel.nodes) || !Array.isArray(bodyModel.edges)) {
                sendError(res, 400, 'model_json muss { nodes: [], edges: [] } sein');
                return;
            }
            opts.modelJson = bodyModel;
        } else {
            const liveDoc = yjsDocs?.get?.(sessionId);
            if (liveDoc) opts.modelJson = modelOf(liveDoc);
        }

        const version = await createVersion(sessionId, content, req.user!.id, opts);
        // Geteilte Stände live an alle pushen — sonst sehen andere Mitglieder einen neuen Stand
        // erst durch den periodischen Poll (bis zu 30s Verzögerung). Persönliche Stände sind
        // ohnehin nur für den Autor sichtbar, daher kein Broadcast nötig.
        if (scope === 'session') {
            broadcastToSession(sessionId, {
                type: 'history.created',
                payload: { version_number: version.version_number, name: version.name, author: req.user!.id },
            });
            // Nur session-scope: das ist der einzige Fall, in dem der gespeicherte Inhalt
            // tatsächlich dem geteilten Live-Canvas entspricht (persönliche Stände sind ein
            // individueller Entwurf, kein gemeinsamer Zustand).
            setActiveVersion(sessionId, version.id);
        }
        res.status(201).json(version);
    } catch (err) {
        next(err);
    }
});

// Berechtigung zum Löschen/Umbenennen eines Stands: personal → nur Autor; session → Autor oder owner.
// Auto-Slots sind nicht manuell verwaltbar (403).
async function ensureCanManageVersion(
    req: Request, res: Response, v: { author_id: string; scope: HistoryScope; kind: string; session_id: string },
): Promise<boolean> {
    if (v.kind === 'auto') {
        sendError(res, 403, 'Automatische Stände können nicht manuell verändert werden');
        return false;
    }
    const isAuthor = v.author_id === req.user!.id;
    if (v.scope === 'personal') {
        if (!isAuthor) {
            sendError(res, 403, 'Nur der Eigentümer darf seinen persönlichen Stand verwalten');
            return false;
        }
        return true;
    }
    // session: Autor oder owner
    if (isAuthor || (await checkSessionOwner(req.user!.id, v.session_id))) return true;
    sendError(res, 403, 'Nur der Ersteller oder ein Owner darf diesen Stand verwalten');
    return false;
}

historyRoutes.delete('/history/:versionId', requireUuidParam('versionId'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { versionId } = req.params;
        const v = await getVersionById(versionId);
        if (!v) {
            sendError(res, 404, 'Stand nicht gefunden');
            return;
        }
        if (!(await ensureCanManageVersion(req, res, v))) return;
        await deleteVersionById(versionId);
        res.status(204).send();
    } catch (err) {
        next(err);
    }
});

// PATCH  /history/:versionId { content?, model_json?, name? } – Inhalt/Modell atomar aktualisieren
//        (dieselbe id/version_number bleiben erhalten, kein Delete+Insert)
historyRoutes.patch('/history/:versionId', requireUuidParam('versionId'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { versionId } = req.params;

        const hasContent   = typeof req.body.content === 'string';
        const hasModelJson = req.body.model_json !== undefined;
        const hasName      = typeof req.body.name === 'string';

        // Reines Umbenennen bleibt auf dem bestehenden, unveränderten Pfad.
        if (!hasContent && !hasModelJson) {
            const name = hasName ? req.body.name.trim() : '';
            if (name.length === 0) {
                sendError(res, 400, 'name darf nicht leer sein');
                return;
            }
            const v = await getVersionById(versionId);
            if (!v) {
                sendError(res, 404, 'Stand nicht gefunden');
                return;
            }
            if (!(await ensureCanManageVersion(req, res, v))) return;
            res.json(await renameVersion(versionId, name));
            return;
        }

        // Content-/Modell-Update: Validierung analog zum POST-Handler oben.
        if (hasContent && req.body.content.trim().length === 0) {
            sendError(res, 400, 'content darf nicht leer sein');
            return;
        }
        let modelJson: PlainModelJson | null | undefined;
        if (hasModelJson) {
            const bodyModel = req.body.model_json;
            if (bodyModel !== null && (typeof bodyModel !== 'object' || !Array.isArray(bodyModel.nodes) || !Array.isArray(bodyModel.edges))) {
                sendError(res, 400, 'model_json muss { nodes: [], edges: [] } oder null sein');
                return;
            }
            modelJson = bodyModel;
        }
        if (hasName && req.body.name.trim().length === 0) {
            sendError(res, 400, 'name darf nicht leer sein');
            return;
        }

        const v = await getVersionById(versionId);
        if (!v) {
            sendError(res, 404, 'Stand nicht gefunden');
            return;
        }
        if (!(await ensureCanManageVersion(req, res, v))) return;

        const updated = await updateVersion(versionId, {
            name: hasName ? req.body.name.trim() : undefined,
            content: hasContent ? req.body.content : undefined,
            modelJson,
            hasModelJson,
        });
        if (!updated) {
            sendError(res, 404, 'Stand nicht gefunden');
            return;
        }

        // Geteilte Stände live an alle pushen (analog history.created), sonst sehen andere
        // Mitglieder das Update erst durch den periodischen Poll (bis zu 30s Verzögerung).
        if (v.scope === 'session') {
            broadcastToSession(v.session_id, {
                type: 'history.updated',
                payload: { version_number: updated.version_number, name: updated.name, author: req.user!.id },
            });
            // Der aktualisierte Inhalt kommt vom aktuell gerenderten Live-Canvas des Aufrufers
            // (siehe FE updateVersion()) — entspricht also jetzt dem geteilten Stand.
            setActiveVersion(v.session_id, updated.id);
        }

        res.json(updated);
    } catch (err) {
        next(err);
    }
});
