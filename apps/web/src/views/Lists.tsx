import { fold } from '@do-it/parser';
import { useState } from 'react';
import { QuickAdd } from '../components/QuickAdd';
import { byDue, TaskList } from '../components/TaskList';
import { useData } from '../lib/data';
import type { Task } from '../lib/db';
import { syncState } from '../lib/sync';
import { useNow } from '../lib/time';

export function LabelView({ name }: { name: string }) {
  const { tasks } = useData();
  const list = tasks.filter((t) => !t.completedAt && t.labels.some((l) => l.toLowerCase() === name.toLowerCase())).sort(byDue);
  return (
    <div className="page">
      <div className="page-head">
        <h1>@{name}</h1>
        <span className="sub">{list.length} offen</span>
      </div>
      <QuickAdd initialText="" placeholder={`Neue Aufgabe mit @${name}`} key={name} />
      <p className="small muted">Tipp: Schreib „@{name}“ in die Eingabe, um das Label zu setzen.</p>
      <TaskList tasks={list} />
    </div>
  );
}

export function SearchView() {
  const { tasks } = useData();
  const [q, setQ] = useState('');
  const [done, setDone] = useState(false);
  const needle = fold(q.trim());
  const list = needle
    ? tasks.filter((t) => (done || !t.completedAt) && (fold(t.title).includes(needle) || fold(t.description).includes(needle) || t.labels.some((l) => fold(l).includes(needle)))).slice(0, 200)
    : [];
  return (
    <div className="page">
      <div className="page-head">
        <h1>Suchen</h1>
      </div>
      <input className="input" autoFocus placeholder="Titel, Beschreibung oder Label …" value={q} onChange={(e) => setQ(e.target.value)} />
      <label className="row small muted" style={{ marginTop: 8 }}>
        <input type="checkbox" checked={done} onChange={(e) => setDone(e.target.checked)} /> Erledigte einbeziehen
      </label>
      {needle && !list.length && <div className="empty">Nichts gefunden.</div>}
      <TaskList tasks={list} />
    </div>
  );
}

export const FILTERS: Record<string, { title: string; empty: string; match: (t: Task, ctx: { me: string; today: string }) => boolean }> = {
  mine: { title: 'Mir zugewiesen', empty: 'Dir ist gerade nichts zugewiesen.', match: (t, c) => t.assigneeId === c.me },
  p1: { title: 'Priorität 1', empty: 'Nichts Dringendes. 👍', match: (t) => t.priority === 1 },
  nodate: { title: 'Ohne Datum', empty: 'Alle Aufgaben haben ein Datum.', match: (t) => !t.dueDate && !t.parentId },
  deadline: { title: 'Mit Deadline', empty: 'Keine Deadlines.', match: (t) => !!t.deadline },
};

export function FilterView({ name }: { name: string }) {
  const { tasks } = useData();
  const { me } = syncState.use();
  const now = useNow();
  const f = FILTERS[name];
  if (!f || !me) return <div className="page"><div className="empty">Unbekannter Filter.</div></div>;
  const list = tasks.filter((t) => !t.completedAt && f.match(t, { me: me.id, today: now.date })).sort(byDue);
  return (
    <div className="page">
      <div className="page-head">
        <h1>{f.title}</h1>
        <span className="sub">{list.length} offen</span>
      </div>
      {list.length ? <TaskList tasks={list} /> : <div className="empty">{f.empty}</div>}
    </div>
  );
}
