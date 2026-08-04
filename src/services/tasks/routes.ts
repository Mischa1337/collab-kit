// H7 — Aufgaben-/Zuständigkeits-Ebene (REST).
// Rollen: anlegen/ändern = owner/member; lesen = alle Mitglieder; löschen = Ersteller oder owner.
import { Router, Request, Response, NextFunction } from 'express';
import { sendError } from '../../utils/http';
import { requireUuidParam } from '../../middleware/validateParams';
import {
  requireModelEditor,
  requireSessionMember,
  getSessionRole,
  canEditModel,
  checkSessionOwner,
} from '../../middleware/authorization';
import { broadcastToSession } from '../../utils/broadcast';
import { createTask, getTasks, getTask, updateTask, deleteTask, TaskStatus } from './tasks.service';
import { notifyTaskAssigned } from '../notifications/notification.service';

export const taskRoutes = Router();

const VALID_STATUS: TaskStatus[] = ['open', 'in_progress', 'done'];

// POST /sessions/:id/tasks — Aufgabe anlegen (owner/member)
taskRoutes.post('/sessions/:id/tasks', requireModelEditor, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const { title, description, assignee_user_id } = req.body;

    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      sendError(res, 400, 'title ist ein Pflichtfeld');
      return;
    }
    if (description !== undefined && description !== null && typeof description !== 'string') {
      sendError(res, 400, 'description muss ein String sein');
      return;
    }
    if (assignee_user_id !== undefined && assignee_user_id !== null && typeof assignee_user_id !== 'string') {
      sendError(res, 400, 'assignee_user_id muss ein String sein');
      return;
    }

    const task = await createTask(id, req.user!.id, {
      title: title.trim(),
      description: description ?? null,
      assigneeUserId: assignee_user_id ?? null,
    });
    broadcastToSession(id, { type: 'task.created', payload: task });
    // Zugewiesenen benachrichtigen (best-effort; nicht an sich selbst).
    void notifyTaskAssigned(task.assignee_user_id, id, task.id, req.user!.id, task.title);
    res.status(201).json(task);
  } catch (err) {
    // FK-Violation (23503): Session existiert nicht
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === '23503') {
      sendError(res, 404, 'Session nicht gefunden');
      return;
    }
    next(err);
  }
});

// GET /sessions/:id/tasks — Aufgabenliste (alle Mitglieder)
taskRoutes.get('/sessions/:id/tasks', requireSessionMember, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.json(await getTasks(req.params.id));
  } catch (err) {
    next(err);
  }
});

// PATCH /tasks/:taskId — ändern/zuweisen/Status (owner/member; Session aus der Aufgabe aufgelöst)
taskRoutes.patch('/tasks/:taskId', requireUuidParam('taskId'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { taskId } = req.params;
    const existing = await getTask(taskId);
    if (!existing) {
      sendError(res, 404, 'Aufgabe nicht gefunden');
      return;
    }
    const { title, description, assignee_user_id, status } = req.body;

    // Rechte (fein getrennt):
    //  - STATUS ändern darf NUR der Zugewiesene — die Aufgabe „gehört" ihm; der Aufgabensteller/andere
    //    owner/member sollen ihm nicht den Fortschritt umstellen. Ist NIEMAND zugewiesen, dürfen
    //    ersatzweise owner/member (sonst bliebe der Status einer freien Aufgabe hängen).
    //  - Titel/Beschreibung/Neu-Zuweisung: nur owner/member (Aufgaben-Verwaltung).
    const role = await getSessionRole(req.user!.id, existing.session_id);
    const isEditor = canEditModel(role); // owner/member
    const isAssignee = existing.assignee_user_id != null && existing.assignee_user_id === req.user!.id;

    const changesMeta = title !== undefined || description !== undefined || assignee_user_id !== undefined;
    if (changesMeta && !isEditor) {
      sendError(res, 403, 'Nur owner/member dürfen Titel, Beschreibung oder Zuweisung ändern');
      return;
    }
    if (status !== undefined) {
      const mayChangeStatus = isAssignee || (existing.assignee_user_id == null && isEditor);
      if (!mayChangeStatus) {
        sendError(res, 403, 'Den Status darf nur der Zugewiesene ändern');
        return;
      }
    }

    if (title !== undefined && (typeof title !== 'string' || title.trim().length === 0)) {
      sendError(res, 400, 'title darf nicht leer sein');
      return;
    }
    if (description !== undefined && description !== null && typeof description !== 'string') {
      sendError(res, 400, 'description muss ein String sein');
      return;
    }
    if (assignee_user_id !== undefined && assignee_user_id !== null && typeof assignee_user_id !== 'string') {
      sendError(res, 400, 'assignee_user_id muss ein String sein');
      return;
    }
    if (status !== undefined && !VALID_STATUS.includes(status)) {
      sendError(res, 400, "status muss 'open', 'in_progress' oder 'done' sein");
      return;
    }

    const updated = await updateTask(taskId, {
      title: title !== undefined ? title.trim() : undefined,
      description,
      assigneeUserId: assignee_user_id,
      status,
    });
    broadcastToSession(existing.session_id, { type: 'task.updated', payload: updated });
    // Nur bei NEUER Zuweisung benachrichtigen (nicht bei jeder Status-/Titel-Änderung).
    if (updated && assignee_user_id !== undefined && updated.assignee_user_id && updated.assignee_user_id !== existing.assignee_user_id) {
      void notifyTaskAssigned(updated.assignee_user_id, existing.session_id, taskId, req.user!.id, updated.title);
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DELETE /tasks/:taskId — löschen (Ersteller oder owner)
taskRoutes.delete('/tasks/:taskId', requireUuidParam('taskId'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { taskId } = req.params;
    const existing = await getTask(taskId);
    if (!existing) {
      sendError(res, 404, 'Aufgabe nicht gefunden');
      return;
    }
    const isOwner = await checkSessionOwner(req.user!.id, existing.session_id);
    if (existing.created_by !== req.user!.id && !isOwner) {
      sendError(res, 403, 'Nur der Ersteller oder ein Owner darf die Aufgabe löschen');
      return;
    }
    await deleteTask(taskId);
    broadcastToSession(existing.session_id, { type: 'task.deleted', payload: { id: taskId } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
