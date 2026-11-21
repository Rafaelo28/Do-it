import type { BoardGroup, ViewPref } from '@do-it/shared';
import { lazy, Suspense, type ReactNode } from 'react';
import type { Task } from '../lib/db';

// erst laden, wenn die Darstellung gewählt wird – die Liste bleibt schnell
const BoardLayout = lazy(() => import('../components/Board').then((m) => ({ default: m.BoardLayout })));
const CalendarView = lazy(() => import('../components/Calendar').then((m) => ({ default: m.CalendarView })));
const TaskTable = lazy(() => import('../components/TaskTable').then((m) => ({ default: m.TaskTable })));
const loading = <div className="small muted">Lade …</div>;

/** Inhalt einer Ansicht in der gewählten Darstellung. `list` ist die gewohnte Liste. */
export function LayoutBody({
  prefKey,
  pref,
  setPref,
  tasks,
  list,
  groups,
  projectId,
  showProject = true,
}: {
  prefKey: string;
  pref: ViewPref;
  setPref: (p: Partial<ViewPref>) => void;
  /** offene Aufgaben der Ansicht */
  tasks: Task[];
  list: ReactNode;
  groups: BoardGroup[];
  projectId?: string;
  showProject?: boolean;
}) {
  switch (pref.layout) {
    case 'board':
      return (
        <Suspense fallback={loading}>
          <BoardLayout tasks={tasks} group={pref.group ?? groups[0]!} groups={groups} onGroup={(group) => setPref({ group })} projectId={projectId} />
        </Suspense>
      );
    case 'calendar':
      return (
        <Suspense fallback={loading}>
          <CalendarView tasks={tasks} prefKey={prefKey} projectId={projectId} unscheduled={tasks.filter((t) => !t.dueDate && !t.parentId)} />
        </Suspense>
      );
    case 'table':
      return (
        <Suspense fallback={loading}>
          <TaskTable tasks={tasks} showProject={showProject} />
        </Suspense>
      );
    default:
      return <>{list}</>;
  }
}
