import { fold } from '@do-it/parser';
import { markdownToText, noteTitle } from '@do-it/shared';
import { useState } from 'react';
import { Link } from 'wouter';
import { IconNote } from '../components/Icons';
import { useNotes } from '../lib/notes';
import { QuickAdd } from '../components/QuickAdd';
import { byDue, TaskList } from '../components/TaskList';
import { useData } from '../lib/data';
import type { Task } from '../lib/db';
import { syncState } from '../lib/sync';
import { useNow } from '../lib/time';
import { useViewPref } from '../lib/views';
import { LayoutSwitch } from '../components/LayoutSwitch';
import { LayoutBody } from './Layouted';

export function LabelView({ name }: { name: string }) {
  const { tasks } = useData();
  const key = `label:${name.toLowerCase()}`;
  const [pref, setPref] = useViewPref(key, { layout: 'list', group: 'project' });
  const layout = pref.layout ?? 'list';
  const all = tasks.filter((t) => !t.completedAt && t.labels.some((l) => l.toLowerCase() === name.toLowerCase())).sort(byDue);
  const list = all.filter((t) => !t.isEvent);
  return (
    <div className={`page ${layout !== 'list' ? 'wide' : ''}`}>
      <div className="page-head">
        <h1>@{name}</h1>
        <span className="sub">{list.length} offen</span>
        <div className="actions">
          <LayoutSwitch value={layout} onChange={(l) => setPref({ layout: l })} />
        </div>
      </div>
      <QuickAdd placeholder={`Neue Aufgabe mit @${name}`} defaults={{ labels: [name] }} key={name} />
      <LayoutBody prefKey={key} pref={{ ...pref, layout }} setPref={setPref} tasks={all} groups={['project', 'priority', 'date']} list={<TaskList tasks={list} />} />
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
  const allNotes = useNotes();
  const notes = needle ? (allNotes ?? []).filter((n) => fold(`${n.title}\n${markdownToText(n.body)}`).includes(needle)).slice(0, 10) : [];
  return (
    <div className="page">
      <div className="page-head">
        <h1>Suchen</h1>
      </div>
      <input className="input" autoFocus placeholder="Titel, Beschreibung oder Label …" value={q} onChange={(e) => setQ(e.target.value)} />
      <label className="row small muted" style={{ marginTop: 8 }}>
        <input type="checkbox" checked={done} onChange={(e) => setDone(e.target.checked)} /> Erledigte einbeziehen
      </label>
      {needle && !list.length && !notes.length && <div className="empty">Nichts gefunden.</div>}
      {notes.length > 0 && (
        <ul className="search-notes" aria-label="Notizen">
          {notes.map((n) => (
            <li key={n.id}>
              <Link href={`/notes/${n.id}`}>
                <IconNote size={16} />
                <span>{noteTitle(n)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <TaskList tasks={list} />
    </div>
  );
}

export const FILTERS: Record<string, { title: string; empty: string; match: (t: Task, ctx: { me: string; today: string }) => boolean }> = {
  mine: { title: 'Mir zugewiesen', empty: 'Dir ist gerade nichts zugewiesen.', match: (t, c) => t.assigneeId === c.me },
  p1: { title: 'Priorität 1', empty: 'Nichts Dringendes.', match: (t) => t.priority === 1 },
  nodate: { title: 'Ohne Datum', empty: 'Alle Aufgaben haben ein Datum.', match: (t) => !t.dueDate && !t.parentId },
  deadline: { title: 'Mit Deadline', empty: 'Keine Deadlines.', match: (t) => !!t.deadline },
};

export function FilterView({ name }: { name: string }) {
  const { tasks } = useData();
  const { me } = syncState.use();
  const now = useNow();
  const f = FILTERS[name];
  const key = `filter:${name}`;
  const [pref, setPref] = useViewPref(key, { layout: 'list', group: 'project' });
  if (!f || !me) return <div className="page"><div className="empty">Unbekannter Filter.</div></div>;
  const layout = pref.layout ?? 'list';
  const list = tasks.filter((t) => !t.completedAt && !t.isEvent && f.match(t, { me: me.id, today: now.date })).sort(byDue);
  return (
    <div className={`page ${layout !== 'list' ? 'wide' : ''}`}>
      <div className="page-head">
        <h1>{f.title}</h1>
        <span className="sub">{list.length} offen</span>
        <div className="actions">
          <LayoutSwitch value={layout} onChange={(l) => setPref({ layout: l })} />
        </div>
      </div>
      <LayoutBody
        prefKey={key}
        pref={{ ...pref, layout }}
        setPref={setPref}
        tasks={list}
        groups={['project', 'priority', 'date']}
        list={list.length ? <TaskList tasks={list} /> : <div className="empty">{f.empty}</div>}
      />
    </div>
  );
}
