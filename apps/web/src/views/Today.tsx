import { IconSun } from '../components/Icons';
import { addDays, formatDateLong, formatDateRelative } from '@do-it/shared';
import { useState } from 'react';
import { QuickAdd } from '../components/QuickAdd';
import { byDue, TaskList } from '../components/TaskList';
import { updateTask } from '../lib/actions';
import { useData } from '../lib/data';
import { BriefingCard } from './Briefings';
import { toast } from '../lib/store';
import { syncState } from '../lib/sync';
import { localDateOf, useNow } from '../lib/time';

export function TodayView() {
  const { tasks, loaded } = useData();
  const { me } = syncState.use();
  const now = useNow();
  const [showDone, setShowDone] = useState(false);
  const mine = (t: (typeof tasks)[number]) => !t.assigneeId || t.assigneeId === me?.id;
  const open = tasks.filter((t) => !t.completedAt && t.dueDate && mine(t));
  const overdue = open.filter((t) => t.dueDate! < now.date).sort(byDue);
  const today = open.filter((t) => t.dueDate === now.date).sort(byDue);
  const doneToday = tasks.filter((t) => {
    const at = t.completedAt ?? t.lastCompletedAt;
    return !!at && localDateOf(at) === now.date && mine(t);
  });

  return (
    <div className="page">
      <div className="page-head">
        <h1>Heute</h1>
        <span className="sub">{formatDateLong(now.date)}</span>
      </div>
      <BriefingCard />
      <QuickAdd defaults={{ dueDate: now.date }} placeholder="Aufgabe für heute – oder einfach „morgen 9 Uhr …“" />
      {overdue.length > 0 && (
        <>
          <div className="group-head" style={{ color: 'var(--danger)' }}>
            Überfällig <span className="muted">{overdue.length}</span>
            <button
              className="btn ghost small"
              style={{ marginLeft: 'auto', minHeight: 0, padding: '2px 8px' }}
              onClick={() => {
                const before = overdue.map((t) => [t.id, t.dueDate] as const);
                for (const t of overdue) void updateTask(t.id, { dueDate: now.date });
                toast(`${before.length} auf heute verschoben`, {
                  action: { label: 'Rückgängig', run: () => before.forEach(([id, d]) => void updateTask(id, { dueDate: d })) },
                });
              }}
            >
              Alle auf heute
            </button>
          </div>
          <TaskList tasks={overdue} />
        </>
      )}
      <div className="group-head">
        {formatDateRelative(now.date, now.date)} <span className="muted">{today.length}</span>
      </div>
      {today.length ? (
        <TaskList tasks={today} />
      ) : (
        loaded && (
          <div className="empty">
            <div className="big">
              <IconSun size={40} />
            </div>
            {overdue.length ? 'Für heute ist nichts Neues geplant.' : 'Alles erledigt. Genieß den Tag!'}
          </div>
        )
      )}
      {doneToday.length > 0 && (
        <button className="btn ghost small" style={{ marginTop: 16 }} onClick={() => setShowDone((s) => !s)}>
          {showDone ? 'Erledigte ausblenden' : `${doneToday.length} heute erledigt anzeigen`}
        </button>
      )}
      {showDone && <TaskList tasks={doneToday.filter((t) => t.completedAt)} />}
    </div>
  );
}

export function UpcomingView() {
  const { tasks } = useData();
  const { me } = syncState.use();
  const now = useNow();
  const mine = (t: (typeof tasks)[number]) => !t.assigneeId || t.assigneeId === me?.id;
  const open = tasks.filter((t) => !t.completedAt && t.dueDate && mine(t)).sort(byDue);
  const days = Array.from({ length: 14 }, (_, i) => addDays(now.date, i));
  const later = open.filter((t) => t.dueDate! > days[days.length - 1]!);
  const overdue = open.filter((t) => t.dueDate! < now.date);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Demnächst</h1>
      </div>
      {overdue.length > 0 && (
        <>
          <div className="group-head" style={{ color: 'var(--danger)' }}>
            Überfällig <span className="muted">{overdue.length}</span>
          </div>
          <TaskList tasks={overdue} />
        </>
      )}
      {days.map((d) => {
        const list = open.filter((t) => t.dueDate === d);
        const rel = formatDateRelative(d, now.date);
        return (
          <section key={d}>
            <div className="group-head">
              {['Heute', 'Morgen', 'Übermorgen'].includes(rel) ? `${rel} · ${formatDateLong(d)}` : formatDateLong(d)}
              <span className="muted">{list.length || ''}</span>
            </div>
            {list.length > 0 && <TaskList tasks={list} />}
            <DayAdd date={d} />
          </section>
        );
      })}
      {later.length > 0 && (
        <>
          <div className="group-head">Später</div>
          <TaskList tasks={later} />
        </>
      )}
    </div>
  );
}

function DayAdd({ date }: { date: string }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button className="btn ghost small muted" onClick={() => setOpen(true)}>
        + Aufgabe
      </button>
    );
  return (
    <div style={{ margin: '8px 0' }}>
      <QuickAdd autoFocus defaults={{ dueDate: date }} onDone={() => setOpen(false)} placeholder="Aufgabe für diesen Tag" />
    </div>
  );
}
