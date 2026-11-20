import type { ParseResult } from '@do-it/parser';
import {
  completeTaskChanges,
  formatDateRelative,
  generateKeyBetween,
  uuidv7,
  type Me,
  type ReminderData,
  type TaskData,
} from '@do-it/shared';
import { db, type Task } from './db';
import { toast } from './store';
import { sync } from './sync';
import { nowLocal } from './time';

const COLORS = ['#0f8b6c', '#3e63dd', '#e5484d', '#f76b15', '#8e4ec6', '#12a594', '#d6409f', '#978365'];

export async function createProject(name: string, color?: string): Promise<string> {
  const projects = await db.projects.toArray();
  const last = projects.map((p) => p.sortKey).sort().pop() ?? null;
  const id = uuidv7();
  await sync.mutate('project', id, 'put', {
    name: name.trim(),
    color: color ?? COLORS[projects.length % COLORS.length],
    sortKey: generateKeyBetween(last, null),
  });
  return id;
}

export async function updateProject(id: string, changes: Record<string, unknown>): Promise<void> {
  await sync.mutate('project', id, 'put', changes);
}

export async function deleteProject(id: string): Promise<void> {
  await sync.mutate('project', id, 'delete');
}

export async function createSection(projectId: string, name: string): Promise<string> {
  const sections = await db.sections.where('projectId').equals(projectId).toArray();
  const last = sections.map((s) => s.sortKey).sort().pop() ?? null;
  const id = uuidv7();
  await sync.mutate('section', id, 'put', { projectId, name: name.trim(), sortKey: generateKeyBetween(last, null) });
  return id;
}

export async function ensureLabels(names: string[]): Promise<void> {
  if (!names.length) return;
  const existing = await db.labels.toArray();
  for (const name of names) {
    if (!existing.some((l) => l.name.toLowerCase() === name.toLowerCase())) {
      await sync.mutate('label', uuidv7(), 'put', { name, color: null });
    }
  }
}

async function nextTaskKey(projectId: string, parentId: string | null): Promise<string> {
  const siblings = await db.tasks.where('projectId').equals(projectId).toArray();
  const last =
    siblings
      .filter((t) => (t.parentId ?? null) === parentId)
      .map((t) => t.sortKey)
      .sort()
      .pop() ?? null;
  return generateKeyBetween(last, null);
}

export interface CreateOptions {
  projectId: string;
  sectionId?: string | null;
  parentId?: string | null;
  me: Me;
  /** feste Vorgaben, z. B. Datum in der Heute-Ansicht */
  defaults?: Partial<TaskData>;
}

/** Aufgabe aus dem Ergebnis des Parsers anlegen (inkl. neuer Projekte, Labels und Erinnerungen). */
export async function createTaskFromParse(r: ParseResult, opts: CreateOptions): Promise<string> {
  let projectId = r.projectId ?? opts.projectId;
  if (r.newProjectName) projectId = await createProject(r.newProjectName);
  const parentId = opts.parentId ?? null;
  const sectionId = projectId === opts.projectId ? (opts.sectionId ?? null) : null;
  const labels = [...new Set([...(opts.defaults?.labels ?? []), ...r.labels])];
  await ensureLabels(labels);
  const id = uuidv7();
  const data: Partial<TaskData> = {
    ...opts.defaults,
    projectId,
    sectionId,
    parentId,
    title: r.title,
    priority: r.priority,
    dueDate: r.dueDate ?? opts.defaults?.dueDate ?? null,
    dueTime: r.dueTime,
    deadline: r.deadline,
    durationMin: r.durationMin,
    recurrence: r.recurrence,
    assigneeId: r.assigneeId,
    rotation: r.rotation,
    labels,
    sortKey: await nextTaskKey(projectId, parentId),
    createdBy: opts.me.id,
    createdAt: new Date().toISOString(),
  };
  await sync.mutate('task', id, 'put', data as Record<string, unknown>);
  const reminders: ReminderData[] = r.reminders.map((rem) =>
    rem.kind === 'relative'
      ? { taskId: id, kind: 'relative', offsetMin: rem.offsetMin, date: null, time: null }
      : { taskId: id, kind: 'absolute', offsetMin: null, date: rem.date, time: rem.time },
  );
  const auto = opts.me.settings.autoReminderMin;
  if (!reminders.length && auto !== null && data.dueDate && data.dueTime) {
    reminders.push({ taskId: id, kind: 'relative', offsetMin: auto, date: null, time: null });
  }
  for (const rem of reminders) await sync.mutate('reminder', uuidv7(), 'put', rem as unknown as Record<string, unknown>);
  return id;
}

export async function updateTask(id: string, changes: Partial<TaskData>): Promise<void> {
  await sync.mutate('task', id, 'put', changes as Record<string, unknown>);
}

/** In ein anderes Projekt verschieben – Unteraufgaben ziehen mit, Zuständigkeit wird gelöst, wenn die Person dort fehlt. */
export async function moveTask(id: string, projectId: string, memberIds: string[]): Promise<void> {
  const all = await db.tasks.toArray();
  const ids = [id];
  for (let i = 0; i < ids.length; i++) for (const t of all) if (t.parentId === ids[i]) ids.push(t.id);
  for (const tid of ids) {
    const t = all.find((x) => x.id === tid)!;
    const keep = (u: string | null) => !u || memberIds.includes(u);
    await updateTask(tid, {
      projectId,
      sectionId: null,
      ...(keep(t.assigneeId) ? {} : { assigneeId: null }),
      ...(t.rotation.every((u) => memberIds.includes(u)) ? {} : { rotation: [] }),
    });
  }
}

export async function deleteTask(task: Task): Promise<void> {
  await sync.mutate('task', task.id, 'delete');
  toast(`„${task.title}“ gelöscht`);
}

/** Abhaken mit Rückgängig. Wiederkehrende Aufgaben springen zum nächsten Termin. */
export async function toggleTask(task: Task, me: Me): Promise<void> {
  if (task.completedAt) {
    await updateTask(task.id, { completedAt: null, completedBy: null });
    return;
  }
  const today = nowLocal().date;
  const changes = completeTaskChanges(task, today, me.id, new Date().toISOString());
  const undo = Object.fromEntries(Object.keys(changes).map((k) => [k, task[k as keyof Task] ?? null])) as Partial<TaskData>;
  await updateTask(task.id, changes);
  const text = changes.dueDate ? `Erledigt – nächstes Mal ${formatDateRelative(changes.dueDate, today)}` : `„${task.title}“ erledigt`;
  toast(text, { action: { label: 'Rückgängig', run: () => void updateTask(task.id, undo) } });
}

export async function addReminder(r: ReminderData): Promise<void> {
  await sync.mutate('reminder', uuidv7(), 'put', r as unknown as Record<string, unknown>);
}

export async function deleteReminder(id: string): Promise<void> {
  await sync.mutate('reminder', id, 'delete');
}

export async function addComment(taskId: string, body: string, me: Me): Promise<void> {
  await sync.mutate('comment', uuidv7(), 'put', { taskId, body, authorId: me.id, createdAt: new Date().toISOString() });
}

export async function deleteComment(id: string): Promise<void> {
  await sync.mutate('comment', id, 'delete');
}
