// H7 — Aufgaben-/Zuständigkeits-Ebene je Session (Feinkoordination).
// Schlanke To-do-Liste; importiert nur db → kein Zirkelimport.
import { db } from '../../config/db';

export type TaskStatus = 'open' | 'in_progress' | 'done';

export interface SessionTask {
  id: string;
  session_id: string;
  title: string;
  description: string | null;
  assignee_user_id: string | null;
  status: TaskStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const TASK_COLS =
  'id, session_id, title, description, assignee_user_id, status, created_by, created_at, updated_at';

export async function createTask(
  sessionId: string,
  createdBy: string,
  input: { title: string; description?: string | null; assigneeUserId?: string | null },
): Promise<SessionTask> {
  const { rows } = await db.query(
    `INSERT INTO session_tasks (session_id, title, description, assignee_user_id, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${TASK_COLS}`,
    [sessionId, input.title, input.description ?? null, input.assigneeUserId ?? null, createdBy],
  );
  return rows[0];
}

export async function getTasks(sessionId: string): Promise<SessionTask[]> {
  const { rows } = await db.query(
    `SELECT ${TASK_COLS} FROM session_tasks WHERE session_id = $1 ORDER BY created_at ASC`,
    [sessionId],
  );
  return rows;
}

export async function getTask(taskId: string): Promise<SessionTask | undefined> {
  const { rows } = await db.query(`SELECT ${TASK_COLS} FROM session_tasks WHERE id = $1`, [taskId]);
  return rows[0];
}

// Teil-Update: nur übergebene Felder ändern (dynamische SET-Klausel). updated_at immer mit.
export async function updateTask(
  taskId: string,
  fields: { title?: string; description?: string | null; assigneeUserId?: string | null; status?: TaskStatus },
): Promise<SessionTask | undefined> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };

  if (fields.title !== undefined)         add('title', fields.title);
  if (fields.description !== undefined)   add('description', fields.description ?? null);
  if (fields.assigneeUserId !== undefined) add('assignee_user_id', fields.assigneeUserId ?? null);
  if (fields.status !== undefined)        add('status', fields.status);

  if (sets.length === 0) return getTask(taskId); // nichts zu ändern → aktueller Stand

  params.push(taskId);
  const { rows } = await db.query(
    `UPDATE session_tasks SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${params.length}
     RETURNING ${TASK_COLS}`,
    params,
  );
  return rows[0];
}

export async function deleteTask(taskId: string): Promise<boolean> {
  const { rowCount } = await db.query(`DELETE FROM session_tasks WHERE id = $1`, [taskId]);
  return (rowCount ?? 0) > 0;
}
