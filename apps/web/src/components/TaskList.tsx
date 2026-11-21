import { isOverdue } from '@do-it/shared';
import { memo, useMemo } from 'react';
import { useLocation } from 'wouter';
import { toggleTask } from '../lib/actions';
import { useData } from '../lib/data';
import type { Task } from '../lib/db';
import { dragState, startDrag } from '../lib/dnd';
import { syncState } from '../lib/sync';
import { useNow } from '../lib/time';
import { IconBell, IconCheck, IconClock, IconFlag, IconGrip, IconHash, IconRepeat, IconSubtasks, IconTag, IconCalendar } from './Icons';
import { Avatar } from './Avatar';
import { dueLabel, durationLabel, PRIORITY_COLOR } from './ui';

/** Fällige zuerst nach Datum/Uhrzeit, dann Priorität, dann manuelle Reihenfolge. */
export function byDue(a: Task, b: Task): number {
  const da = a.dueDate ?? '9999';
  const dbb = b.dueDate ?? '9999';
  if (da !== dbb) return da < dbb ? -1 : 1;
  const ta = a.dueTime ?? '99';
  const tb = b.dueTime ?? '99';
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0;
}

interface ItemProps {
  task: Task;
  projectLabel: string | null;
  subCount: number;
  subDone: number;
  hasReminder: boolean;
  assigneeName: string | null;
  assigneeAvatar: string | null;
  today: string;
  nowTime: string;
  sub: boolean;
  sortable: boolean;
}

/** Nur die Felder, die eine Zeile anzeigt – so wird eine Aufgabe nur neu gezeichnet, wenn sie sich sichtbar ändert. */
function sameTask(a: Task, b: Task): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.title === b.title &&
      a.completedAt === b.completedAt &&
      a.dueDate === b.dueDate &&
      a.dueTime === b.dueTime &&
      a.deadline === b.deadline &&
      a.durationMin === b.durationMin &&
      a.isEvent === b.isEvent &&
      a.priority === b.priority &&
      a.assigneeId === b.assigneeId &&
      a.projectId === b.projectId &&
      a.sectionId === b.sectionId &&
      a.parentId === b.parentId &&
      !!a.recurrence === !!b.recurrence &&
      a.labels.join('\u0000') === b.labels.join('\u0000') &&
      a.rotation.length === b.rotation.length)
  );
}

const TaskRow = memo(
  function TaskRow({ task, projectLabel, subCount, subDone, hasReminder, assigneeName, assigneeAvatar, today, nowTime, sub, sortable }: ItemProps) {
    const me = syncState.select((s) => s.me);
    const [, navigate] = useLocation();
    const canDrag = sortable && !sub && !task.completedAt;
    const dragClass = dragState.select((s) =>
      !s.id ? '' : s.id === task.id ? 'dragging' : s.overId === task.id ? (s.pos === 'before' ? 'drop-before' : 'drop-after') : '',
    );
    const overdue = isOverdue(task, today) || (!task.completedAt && task.dueDate === today && !!task.dueTime && task.dueTime < nowTime);

    return (
      <li
        className={`task ${task.completedAt ? 'completed' : ''} ${sub ? 'sub' : ''} ${dragClass}`}
        data-task-id={task.id}
        data-section-id={task.sectionId ?? ''}
        data-sortable={canDrag ? '1' : undefined}
        onClick={() => navigate(`/task/${task.id}`)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && navigate(`/task/${task.id}`)}
      >
        {canDrag && (
          <span
            className="drag-handle"
            aria-label="Ziehen zum Sortieren"
            title="Ziehen zum Sortieren"
            onPointerDown={(e) => startDrag(e, task.id, task.projectId)}
            onClick={(e) => e.stopPropagation()}
          >
            <IconGrip size={16} />
          </span>
        )}
        {task.isEvent ? (
          <span className="event-mark" title="Termin" aria-label="Termin">
            <IconCalendar size={14} />
          </span>
        ) : (
          <button
            className={`check ${task.completedAt ? 'done' : ''}`}
            style={{ '--pc': PRIORITY_COLOR[task.priority] } as React.CSSProperties}
            aria-label={task.completedAt ? 'Als offen markieren' : 'Erledigt'}
            onClick={(e) => {
              e.stopPropagation();
              if (me) void toggleTask(task, me);
            }}
          >
            <IconCheck size={13} />
          </button>
        )}
        <div className="task-body">
          <div className="task-title">{task.title}</div>
          <div className="meta">
            {task.dueDate && (
              <span className={overdue ? 'overdue' : task.dueDate === today ? 'today' : ''}>
                {task.recurrence ? <IconRepeat size={12} /> : <IconClock size={12} />}
                {dueLabel(task.dueDate, task.dueTime, today)}
              </span>
            )}
            {task.deadline && (
              <span className={task.deadline < today ? 'overdue' : ''}>
                <IconFlag size={12} /> {dueLabel(task.deadline, null, today)}
              </span>
            )}
            {task.durationMin && <span>{durationLabel(task.durationMin)}</span>}
            {subCount > 0 && (
              <span title="Unteraufgaben">
                <IconSubtasks size={12} />
                {subDone}/{subCount}
              </span>
            )}
            {hasReminder && (
              <span title="Erinnerung">
                <IconBell size={12} />
              </span>
            )}
            {task.labels.map((l) => (
              <span key={l}>
                <IconTag size={12} />
                {l}
              </span>
            ))}
            {projectLabel && (
              <span>
                <IconHash size={12} />
                {projectLabel}
              </span>
            )}
            {assigneeName && (
              <span title={assigneeName}>
                <Avatar name={assigneeName} src={assigneeAvatar} size={18} seed={task.assigneeId ?? undefined} />
                {task.rotation.length > 1 ? 'dran' : ''}
              </span>
            )}
          </div>
        </div>
      </li>
    );
  },
  (a, b) =>
    sameTask(a.task, b.task) &&
    a.projectLabel === b.projectLabel &&
    a.subCount === b.subCount &&
    a.subDone === b.subDone &&
    a.hasReminder === b.hasReminder &&
    a.assigneeName === b.assigneeName &&
    a.assigneeAvatar === b.assigneeAvatar &&
    a.today === b.today &&
    a.nowTime === b.nowTime &&
    a.sub === b.sub &&
    a.sortable === b.sortable,
);

export function TaskList({
  tasks,
  showProject = true,
  showSubtasks = true,
  sortable = false,
}: {
  tasks: Task[];
  showProject?: boolean;
  showSubtasks?: boolean;
  sortable?: boolean;
}) {
  const { projectMap, childStats, remindedTasks } = useData();
  const members = syncState.select((s) => s.members);
  const now = useNow();
  const memberNames = useMemo(() => new Map(members.map((m) => [m.userId, m.name])), [members]);
  const memberAvatars = useMemo(() => new Map(members.map((m) => [m.userId, m.avatar])), [members]);

  const ids = new Set(tasks.map((t) => t.id));
  const childrenOf = new Map<string, Task[]>();
  for (const t of tasks) if (t.parentId && ids.has(t.parentId)) childrenOf.set(t.parentId, [...(childrenOf.get(t.parentId) ?? []), t]);
  // Unteraufgaben erscheinen unter ihrer Hauptaufgabe, wenn diese in der Liste ist.
  const top = tasks.filter((t) => !t.parentId || !ids.has(t.parentId));

  const row = (t: Task, sub: boolean, withProject: boolean) => {
    const project = projectMap.get(t.projectId);
    const stats = childStats.get(t.id);
    return (
      <TaskRow
        key={t.id}
        task={t}
        projectLabel={withProject && project && !project.isInbox ? project.name : null}
        subCount={stats?.total ?? 0}
        subDone={stats?.done ?? 0}
        hasReminder={remindedTasks.has(t.id)}
        assigneeName={t.assigneeId ? (memberNames.get(t.assigneeId) ?? null) : null}
        assigneeAvatar={t.assigneeId ? (memberAvatars.get(t.assigneeId) ?? null) : null}
        today={now.date}
        nowTime={t.dueDate === now.date && t.dueTime ? now.time : ''}
        sub={sub}
        sortable={sortable}
      />
    );
  };

  return (
    <ul className="task-list">
      {top.flatMap((t) => [
        row(t, !!t.parentId && ids.has(t.parentId), showProject),
        ...(showSubtasks ? (childrenOf.get(t.id) ?? []).map((c) => row(c, true, false)) : []),
      ])}
    </ul>
  );
}
