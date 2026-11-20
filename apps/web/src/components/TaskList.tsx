import { isOverdue } from '@do-it/shared';
import { useLocation } from 'wouter';
import { toggleTask } from '../lib/actions';
import { useData } from '../lib/data';
import type { Task } from '../lib/db';
import { syncState } from '../lib/sync';
import { useNow } from '../lib/time';
import { IconBell, IconCheck, IconClock, IconFlag, IconHash, IconRepeat, IconTag } from './Icons';
import { dueLabel, durationLabel, initials, PRIORITY_COLOR } from './ui';

/** Fällige zuerst nach Datum/Uhrzeit, dann Priorität, dann manuelle Reihenfolge. */
export function byDue(a: Task, b: Task): number {
  const da = a.dueDate ?? '9999';
  const dbb = b.dueDate ?? '9999';
  if (da !== dbb) return da < dbb ? -1 : 1;
  const ta = a.dueTime ?? '99';
  const tb = b.dueTime ?? '99';
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.sortKey < b.sortKey ? -1 : 1;
}

export function TaskItem({ task, showProject = true, sub = false }: { task: Task; showProject?: boolean; sub?: boolean }) {
  const { projectMap, reminders, tasks } = useData();
  const { me, members } = syncState.use();
  const now = useNow();
  const [, navigate] = useLocation();
  const project = projectMap.get(task.projectId);
  const overdue = isOverdue(task, now.date) || (!task.completedAt && task.dueDate === now.date && !!task.dueTime && task.dueTime < now.time);
  const hasReminder = reminders.some((r) => r.taskId === task.id);
  const subCount = tasks.filter((t) => t.parentId === task.id).length;
  const subDone = tasks.filter((t) => t.parentId === task.id && t.completedAt).length;
  const assignee = task.assigneeId ? members.find((m) => m.userId === task.assigneeId) : undefined;

  return (
    <li
      className={`task ${task.completedAt ? 'completed' : ''} ${sub ? 'sub' : ''}`}
      onClick={() => navigate(`/task/${task.id}`)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && navigate(`/task/${task.id}`)}
    >
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
      <div className="task-body">
        <div className="task-title">{task.title}</div>
        <div className="meta">
          {task.dueDate && (
            <span className={overdue ? 'overdue' : task.dueDate === now.date ? 'today' : ''}>
              {task.recurrence ? <IconRepeat size={12} /> : <IconClock size={12} />}
              {dueLabel(task.dueDate, task.dueTime, now.date)}
            </span>
          )}
          {task.deadline && (
            <span className={task.deadline < now.date ? 'overdue' : ''}>
              <IconFlag size={12} /> {dueLabel(task.deadline, null, now.date)}
            </span>
          )}
          {task.durationMin && <span>{durationLabel(task.durationMin)}</span>}
          {subCount > 0 && (
            <span>
              ☑ {subDone}/{subCount}
            </span>
          )}
          {hasReminder && (
            <span>
              <IconBell size={12} />
            </span>
          )}
          {task.labels.map((l) => (
            <span key={l}>
              <IconTag size={12} />
              {l}
            </span>
          ))}
          {showProject && project && !project.isInbox && (
            <span>
              <IconHash size={12} />
              {project.name}
            </span>
          )}
          {assignee && (
            <span title={assignee.name}>
              <span className="avatar">{initials(assignee.name)}</span>
              {task.rotation.length > 1 ? 'dran' : ''}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

export function TaskList({ tasks, showProject = true, showSubtasks = true }: { tasks: Task[]; showProject?: boolean; showSubtasks?: boolean }) {
  const { tasks: all } = useData();
  const ids = new Set(tasks.map((t) => t.id));
  // Unteraufgaben erscheinen unter ihrer Hauptaufgabe, wenn diese in der Liste ist.
  const top = tasks.filter((t) => !t.parentId || !ids.has(t.parentId));
  return (
    <ul className="task-list">
      {top.map((t) => (
        <TaskBranch key={t.id} task={t} all={all} visible={ids} showProject={showProject} showSubtasks={showSubtasks} />
      ))}
    </ul>
  );
}

function TaskBranch({ task, all, visible, showProject, showSubtasks }: { task: Task; all: Task[]; visible: Set<string>; showProject: boolean; showSubtasks: boolean }) {
  const children = showSubtasks ? all.filter((t) => t.parentId === task.id && visible.has(t.id)) : [];
  return (
    <>
      <TaskItem task={task} showProject={showProject} sub={!!task.parentId && visible.has(task.parentId)} />
      {children.map((c) => (
        <TaskItem key={c.id} task={c} showProject={false} sub />
      ))}
    </>
  );
}
