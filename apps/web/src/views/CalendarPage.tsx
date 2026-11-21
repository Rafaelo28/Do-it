import { CalendarView } from '../components/Calendar';
import { useData } from '../lib/data';
import { syncState } from '../lib/sync';

/** Kalender über alle eigenen Aufgaben: Tag, Woche, Monat. */
export function CalendarPage() {
  const { tasks } = useData();
  const me = syncState.select((s) => s.me);
  const mine = tasks.filter((t) => !t.completedAt && (!t.assigneeId || t.assigneeId === me?.id));
  return (
    <div className="page wide">
      <div className="page-head">
        <h1>Kalender</h1>
      </div>
      <CalendarView tasks={mine} prefKey="calendar" unscheduled={mine.filter((t) => !t.dueDate && !t.parentId).sort((a, b) => a.priority - b.priority)} />
    </div>
  );
}
