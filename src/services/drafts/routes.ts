// Privates Arbeitsmodell (Entwurf) — REST.
// CRUD: nur der eigene Entwurf (über req.user.id gekeyt). Veröffentlichen: merge=Editor, replace=owner.
import { Router, Request, Response, NextFunction } from 'express';
import * as Y from 'yjs';
import { docs as yjsDocs } from 'y-websocket/bin/utils';
import { sendError } from '../../utils/http';
import { requireSessionMember, ensureModelEditor, checkSessionOwner } from '../../middleware/authorization';
import { upsertDraft, getDraft, deleteDraft } from './drafts.service';
import { buildPreSnapshot, seedAndNotifyLoad, suppressModelDuring } from '../websocket/controller';
import { broadcastToSession } from '../../utils/broadcast';
import { elements, edges, toPlainModel } from '../collaboration/model.types';
import { modelOf } from '../collaboration/modelTracker';

export const draftRoutes = Router();

type PlainField = Record<string, unknown> & { id?: unknown };
type PlainModel = { nodes?: PlainField[]; edges?: PlainField[] };

// Deterministische String-Repräsentation eines Modells (Elemente nach ID sortiert, Felder nach
// Schlüssel sortiert) — unabhängig von Einfüge-/Iterationsreihenfolge (Yjs-Map, JSONB, Canvas-
// Array liefern die nicht garantiert gleich). Für den reinen "hat sich überhaupt was geändert"-
// Vergleich beim Publish-Gate.
function canonicalize(model: PlainModel | null | undefined): string {
  const norm = (arr: PlainField[] | undefined) =>
    (arr ?? [])
      .filter((x) => x?.id != null)
      .map((x) => Object.keys(x).sort().reduce((acc, k) => { acc[k] = x[k]; return acc; }, {} as PlainField))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return JSON.stringify({ nodes: norm(model?.nodes), edges: norm(model?.edges) });
}

// Liefert aus `current` nur die Elemente, die es in `base` nicht gibt oder die sich gegenüber
// `base` (per ID) in mindestens einem Feld unterscheiden. Das ist der eigentliche Merge-Kern:
// nur wirklich selbst Verändertes wird geschrieben — unverändert mitgeschlepptes bleibt außen vor,
// damit es fremde, zwischenzeitliche Änderungen am selben Element nicht überschreibt.
function diffChanged(base: PlainField[] | undefined, current: PlainField[] | undefined): PlainField[] {
  const baseById = new Map((base ?? []).filter((x) => x?.id != null).map((x) => [String(x.id), x]));
  return (current ?? []).filter((item) => {
    if (item?.id == null) return false;
    const b = baseById.get(String(item.id));
    if (!b) return true; // neu (gab's in der Basis noch nicht)
    const keys = new Set([...Object.keys(b), ...Object.keys(item)]);
    for (const k of keys) {
      if (k === 'id') continue;
      if (JSON.stringify(b[k]) !== JSON.stringify(item[k])) return true; // verändert
    }
    return false; // identisch zur Basis → unverändert mitgeschleppt, nicht schreiben
  });
}

// GET /sessions/:id/draft — meinen Entwurf laden (oder leer).
draftRoutes.get('/sessions/:id/draft', requireSessionMember, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const draft = await getDraft(req.params.id, req.user!.id);
    res.json(draft ?? { session_id: req.params.id, user_id: req.user!.id, content: '', model_json: null });
  } catch (err) {
    next(err);
  }
});

// PUT /sessions/:id/draft — meinen Entwurf upserten (FE gedrosselt).
// base_snapshot (optional): der gemeinsame Stand, auf dem der Entwurf gerade aufbaut (vom FE beim
// Wechsel nach Privat bzw. bei "Gemeinsamen Stand übernehmen" mitgeschickt) — Grundlage für den
// Merge-Diff und die Aktualitätsprüfung beim Veröffentlichen. Fehlt das Feld im Body, bleibt der
// zuletzt gespeicherte Wert unangetastet (reines Content-Update, z. B. Auto-Save während der Arbeit).
draftRoutes.put('/sessions/:id/draft', requireSessionMember, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { content, model_json, base_snapshot } = req.body;
    if (content !== undefined && typeof content !== 'string') {
      sendError(res, 400, 'content muss ein String sein');
      return;
    }
    const draft = await upsertDraft(req.params.id, req.user!.id, content ?? '', model_json ?? null, base_snapshot);
    res.json(draft);
  } catch (err) {
    // FK-Violation (23503): Session existiert nicht
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === '23503') {
      sendError(res, 404, 'Session nicht gefunden');
      return;
    }
    next(err);
  }
});

// DELETE /sessions/:id/draft — meinen Entwurf verwerfen.
draftRoutes.delete('/sessions/:id/draft', requireSessionMember, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await deleteDraft(req.params.id, req.user!.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// POST /sessions/:id/draft/publish — Entwurf ins geteilte Doc überführen.
// mode='merge' (additiv, Editor) | mode='replace' (ersetzend, owner). Sichert vorher den Live-Stand,
// schreibt den Entwurf DIREKT ins live Y.Doc (statt ihn nur per Response zurückzugeben) — der
// bestehende y-websocket-Sync verteilt die Änderung dadurch automatisch an alle verbundenen Clients,
// inkl. des veröffentlichenden Nutzers selbst (kommt über den normalen Remote-Update-Pfad zurück).
draftRoutes.post('/sessions/:id/draft/publish', requireSessionMember, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const sessionId = req.params.id;
    const mode = req.body?.mode === 'replace' ? 'replace' : 'merge';

    // Rechte: replace nur owner; merge Editor (owner/member).
    if (mode === 'replace') {
      if (!(await checkSessionOwner(req.user!.id, sessionId))) {
        sendError(res, 403, 'Ersetzendes Veröffentlichen ist nur dem Owner erlaubt');
        return;
      }
    } else if (!(await ensureModelEditor(req.user!.id, sessionId, res))) {
      return;
    }

    const draft = await getDraft(sessionId, req.user!.id);
    if (!draft || (draft.content.trim().length === 0 && !draft.model_json)) {
      sendError(res, 400, 'Kein Entwurf zum Veröffentlichen vorhanden');
      return;
    }

    // Live-Doc nötig, um die Änderung wirklich ins geteilte Dokument zu schreiben (nicht nur
    // in die DB). Ohne aktive Verbindung zur Session (niemand verbunden) gibt es keins.
    const liveDoc = yjsDocs.get(sessionId);
    if (!liveDoc) {
      sendError(res, 409, 'Gemeinsame Sitzung ist gerade nicht aktiv — bitte verbunden bleiben und erneut versuchen');
      return;
    }

    const modelJson = draft.model_json as PlainModel | null;
    const draftNodes = modelJson?.nodes ?? [];
    const draftEdges = modelJson?.edges ?? [];
    const baseSnapshot = draft.base_snapshot as PlainModel | null;

    // Gate NUR für merge: replace ersetzt ohnehin bewusst alles, da ist "veraltet" irrelevant.
    // Ohne gespeicherte Basis (alte Entwürfe von vor diesem Feature) wird nicht blockiert — sonst
    // könnte niemand mehr veröffentlichen, dessen Entwurf vor dem Update entstanden ist.
    if (mode === 'merge' && baseSnapshot) {
      const liveModel = toPlainModel(liveDoc) as unknown as PlainModel;
      if (canonicalize(baseSnapshot) !== canonicalize(liveModel)) {
        sendError(res, 409, 'Der gemeinsame Stand hat sich inzwischen geändert. Bitte zuerst den aktuellen Stand übernehmen, dann erneut veröffentlichen.');
        return;
      }
    }

    // Absicherung NUR für replace: kein hartes Gate wie bei merge (Ersetzen ist ja bewusst ein
    // Vollüberschreiben), aber eine explizite zweite Bestätigung erzwingen, wenn sich der gemeinsame
    // Stand seit der eigenen Basis geändert hat — sonst könnte ein einzelner Klick unbemerkt fremde,
    // zwischenzeitliche Arbeit unwiderruflich löschen. Ohne gespeicherte Basis (alte Entwürfe) wird
    // nicht blockiert, aus demselben Grund wie beim merge-Gate oben.
    if (mode === 'replace' && baseSnapshot && req.body?.confirmReplace !== true) {
      const liveModel = toPlainModel(liveDoc) as unknown as PlainModel;
      if (canonicalize(baseSnapshot) !== canonicalize(liveModel)) {
        res.status(409).json({
          error: {
            message: 'Der gemeinsame Stand hat sich seit deiner letzten Basis geändert. Ersetzen löscht diese fremden Änderungen unwiderruflich.',
            status: 409,
          },
          staleReplace: true,
          liveNodeCount: (liveModel.nodes ?? []).length,
          liveEdgeCount: (liveModel.edges ?? []).length,
        });
        return;
      }
    }

    // Auto-Sicherung des aktuellen geteilten Stands (falls jemand verbunden ist) → rückholbar.
    await buildPreSnapshot(sessionId, 'Stand vor Veröffentlichung', 'system:pre-publish');

    // merge: nur schreiben, was sich gegenüber der Basis wirklich geändert hat (neu oder bearbeitet).
    // Unverändert mitgeschlepptes bleibt außen vor — sonst würde es fremde, zwischenzeitliche
    // Änderungen an genau diesem Element überschreiben, obwohl der Nutzer es nie angefasst hat.
    // Ohne Basis (alter Entwurf) wird defensiv alles geschrieben (bisheriges Verhalten).
    // replace schreibt immer alles — das ist der ganze Sinn von "ersetzen".
    const nodesToWrite = mode === 'merge' && baseSnapshot ? diffChanged(baseSnapshot.nodes, draftNodes) : draftNodes;
    const edgesToWrite = mode === 'merge' && baseSnapshot ? diffChanged(baseSnapshot.edges, draftEdges) : draftEdges;

    // Publish-Write in die Suppress-Klammer: der Server-Modell-Observer überspringt dabei die
    // Frische-Konfliktlogik → replace/merge lösen NIE ein Konflikt-Fenster aus, nur die Publish-Meldung.
    suppressModelDuring(sessionId, () => liveDoc.transact(() => {
      const elMap = elements(liveDoc);
      const edgeMap = edges(liveDoc);

      // replace: geteilten Stand vollständig leeren, bevor der Entwurf reingeschrieben wird.
      if (mode === 'replace') {
        Array.from(elMap.keys()).forEach((id) => elMap.delete(id));
        Array.from(edgeMap.keys()).forEach((id) => edgeMap.delete(id));
      }

      // Pro Knoten-ID upserten. Löschungen aus dem privaten Entwurf werden bewusst NICHT
      // mitgemergt (kein destruktiver Merge über fremde, evtl. neuere Elemente).
      for (const node of nodesToWrite) {
        if (node?.id == null) continue;
        const id = String(node.id);
        let yn = elMap.get(id);
        if (!yn) { yn = new Y.Map<unknown>(); elMap.set(id, yn); }
        for (const [k, v] of Object.entries(node)) yn.set(k, v);
      }

      // Kanten: per ID upserten (ID-adressierte Y.Map<edgeId> — feldgenaues, duplikatfreies Merge).
      for (const edge of edgesToWrite) {
        if (edge?.id == null) continue;
        const id = String(edge.id);
        let ye = edgeMap.get(id);
        if (!ye) { ye = new Y.Map<unknown>(); edgeMap.set(id, ye); }
        for (const [k, v] of Object.entries(edge)) ye.set(k, v);
      }
    }));

    broadcastToSession(sessionId, { type: 'draft.published', payload: { by: req.user!.id, mode } });

    // Wie beim Restore: Diff-Basis auf den neuen geteilten Stand seeden UND die PRIVAT arbeitenden
    // anderen Nutzer über die Glocke informieren (Wer + Was). Wer GEMEINSAM ist, bekommt Dialog/Toast
    // im FE (via draft.published — replace = Dialog, merge = Toast).
    const publishDetail = mode === 'replace'
      ? 'seinen privaten Stand ersetzend in den gemeinsamen integriert'
      : 'seinen privaten Stand additiv (merge) integriert';
    seedAndNotifyLoad(sessionId, req.user!.id, modelOf(liveDoc), publishDetail);

    res.json({ mode });
  } catch (err) {
    next(err);
  }
});
