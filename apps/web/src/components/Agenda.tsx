import { minutesToTime, occurrencesBetween, timeToMinutes, type PlainDate } from '@do-it/shared';
import { Link } from 'wouter';
import { useData } from '../lib/data';
import type { Task } from '../lib/db';
import { syncState } from '../lib/sync';
import { IconBellOff, IconRepeat } from './Icons';

export interface AgendaItem {
  task: Task;
  date: PlainDate;
}

/** Termine (keine To-dos) im Zeitraum, nach Datum und Uhrzeit sortiert – Wiederholungen eingerechnet. */
export function eventsBetween(tasks: Task[], from: PlainDate, to: PlainDate, meId?: string): AgendaItem[] {
  return tasks
    .filter((t) => t.isEvent && t.dueDate && !t.completedAt && (!t.assigneeId || t.assigneeId === meId))
    .flatMap((t) => occurrencesBetween(t.dueDate!, t.recurrence, from, to).map((date) => ({ task: t, date })))
    .sort((a, b) => (a.date + (a.task.dueTime ?? '')).localeCompare(b.date + (b.task.dueTime ?? '')));
}

export function useEvents(from: PlainDate, to: PlainDate, filter?: (t: Task) => boolean): AgendaItem[] {
  const { tasks } = useData();
  const me = syncState.select((s) => s.me);
  return eventsBetween(filter ? tasks.filter(filter) : tasks, from, to, me?.id);
}

/** Termine als kompakte Zeilen: Uhrzeit, Farbe des Projekts, Titel */
export function AgendaList({ items, showDate }: { items: AgendaItem[]; showDate?: (d: PlainDate) => string }) {
  const { projectMap } = useData();
  return (
    <ul className="agenda">
      {items.map(({ task, date }) => {
        const end = task.dueTime && task.durationMin ? minutesToTime(Math.min(1439, timeToMinutes(task.dueTime) + task.durationMin)) : null;
        return (
          <li key={`${task.id}-${date}`}>
            <Link href={`/task/${task.id}`} className="agenda-item" style={{ '--c': projectMap.get(task.projectId)?.color ?? 'var(--accent)' } as React.CSSProperties}>
              <span className="agenda-time">
                {showDate && <span>{showDate(date)} </span>}
                {task.dueTime ? `${task.dueTime}${end ? `–${end}` : ''}` : 'ganztägig'}
              </span>
              <span className="agenda-title">{task.title}</span>
              {task.silent && <IconBellOff size={12} aria-label="stumm" />}
              {task.recurrence && <IconRepeat size={12} />}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
