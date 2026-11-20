import { addDays, diffDays, type PlainDate } from './dates';
import type { TaskData } from './model';
import { nextOccurrence } from './recurrence';

/**
 * Felder, die sich beim Abhaken ändern. Wiederkehrende Aufgaben springen zum nächsten
 * Termin (inkl. Rotation der Zuständigkeit), alle anderen werden erledigt.
 */
export function completeTaskChanges(
  task: Pick<TaskData, 'recurrence' | 'dueDate' | 'deadline' | 'rotation' | 'assigneeId'>,
  today: PlainDate,
  userId: string,
  nowIso: string,
): Partial<TaskData> {
  if (task.recurrence) {
    const next = nextOccurrence(task.recurrence, task.dueDate, today);
    if (next) {
      const changes: Partial<TaskData> = { dueDate: next, lastCompletedAt: nowIso, lastCompletedBy: userId };
      if (task.deadline && task.dueDate) changes.deadline = addDays(task.deadline, diffDays(task.dueDate, next));
      if (task.rotation.length > 1) {
        const idx = task.rotation.indexOf(task.assigneeId ?? '');
        changes.assigneeId = task.rotation[(idx + 1) % task.rotation.length]!;
      }
      return changes;
    }
  }
  return { completedAt: nowIso, completedBy: userId };
}

export function isOverdue(task: Pick<TaskData, 'dueDate' | 'completedAt'>, today: PlainDate): boolean {
  return !task.completedAt && !!task.dueDate && task.dueDate < today;
}

export const PRIORITY_LABELS: Record<number, string> = { 1: 'Priorität 1', 2: 'Priorität 2', 3: 'Priorität 3', 4: 'Keine Priorität' };
