import { useState } from 'react';
import { Link } from 'wouter';
import { toggleTask, updateTask } from '../lib/actions';
import { useData } from '../lib/data';
import type { Task } from '../lib/db';
import { syncState } from '../lib/sync';
import { useNow } from '../lib/time';
import { Avatar } from './Avatar';
import { IconCheck, IconFlag, IconRepeat } from './Icons';
import { PRIORITY_COLOR } from './ui';
import { Select } from './Select';

type Col = 'title' | 'project' | 'due' | 'deadline' | 'duration' | 'priority' | 'labels' | 'assignee';

const HEAD: { key: Col; label: string }[] = [
  { key: 'title', label: 'Aufgabe' },
  { key: 'project', label: 'Projekt' },
  { key: 'due', label: 'Fällig' },
  { key: 'deadline', label: 'Deadline' },
  { key: 'duration', label: 'Dauer' },
  { key: 'priority', label: 'Priorität' },
  { key: 'labels', label: 'Labels' },
  { key: 'assignee', label: 'Zuständig' },
];

const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240, 480];

/** Tabelle: sortierbar per Klick auf die Spaltenköpfe, Datum, Dauer und Priorität direkt änderbar. */
export function TaskTable({ tasks, showProject = true }: { tasks: Task[]; showProject?: boolean }) {
  const { projectMap } = useData();
  const members = syncState.select((s) => s.members);
  const me = syncState.select((s) => s.me);
  const now = useNow();
  const [sort, setSort] = useState<{ col: Col; dir: 1 | -1 }>({ col: 'due', dir: 1 });
  const memberOf = (id: string | null) => members.find((m) => m.userId === id);
  const projectName = (t: Task) => {
    const p = projectMap.get(t.projectId);
    return p ? (p.isInbox ? 'Eingang' : p.name) : '';
  };

  const value = (t: Task, c: Col): string | number => {
    switch (c) {
      case 'title':
        return t.title.toLowerCase();
      case 'project':
        return projectName(t).toLowerCase();
      case 'due':
        return t.dueDate ? `${t.dueDate} ${t.dueTime ?? '99'}` : '9999';
      case 'deadline':
        return t.deadline ?? '9999';
      case 'duration':
        return t.durationMin ?? 1e9;
      case 'priority':
        return t.priority;
      case 'labels':
        return t.labels.join(',').toLowerCase() || '~';
      case 'assignee':
        return memberOf(t.assigneeId)?.name.toLowerCase() ?? '~';
    }
  };
  const sorted = [...tasks].sort((a, b) => {
    const x = value(a, sort.col);
    const y = value(b, sort.col);
    return (x < y ? -1 : x > y ? 1 : 0) * sort.dir || (a.sortKey < b.sortKey ? -1 : 1);
  });
  const cols = HEAD.filter((h) => showProject || h.key !== 'project');

  return (
    <div className="table-wrap">
      <table className="task-table">
        <thead>
          <tr>
            <th aria-label="Erledigt" />
            {cols.map((h) => (
              <th key={h.key} aria-sort={sort.col === h.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                <button onClick={() => setSort((s) => ({ col: h.key, dir: s.col === h.key ? (s.dir === 1 ? -1 : 1) : 1 }))}>
                  {h.label}
                  {sort.col === h.key && <span className="muted">{sort.dir === 1 ? ' ↑' : ' ↓'}</span>}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((t) => {
            const who = memberOf(t.assigneeId);
            return (
              <tr key={t.id}>
                <td>
                  <button className="check" style={{ '--pc': PRIORITY_COLOR[t.priority] } as React.CSSProperties} aria-label="Erledigt" onClick={() => me && void toggleTask(t, me)}>
                    <IconCheck size={12} />
                  </button>
                </td>
                <td className="col-title">
                  <Link href={`/task/${t.id}`}>
                    {t.parentId && <span className="muted">↳ </span>}
                    {t.title}
                  </Link>
                  {t.recurrence && <IconRepeat size={12} />}
                </td>
                {showProject && <td className="muted">{projectName(t)}</td>}
                <td>
                  <input
                    className={`cell-input ${t.dueDate && t.dueDate < now.date ? 'overdue' : ''}`}
                    type="date"
                    aria-label={`Fällig: ${t.title}`}
                    value={t.dueDate ?? ''}
                    onChange={(e) => void updateTask(t.id, e.target.value ? { dueDate: e.target.value } : { dueDate: null, dueTime: null })}
                  />
                  {t.dueTime && <span className="muted small"> {t.dueTime}</span>}
                </td>
                <td>
                  <input
                    className={`cell-input ${t.deadline && t.deadline < now.date ? 'overdue' : ''}`}
                    type="date"
                    aria-label={`Deadline: ${t.title}`}
                    value={t.deadline ?? ''}
                    onChange={(e) => void updateTask(t.id, { deadline: e.target.value || null })}
                  />
                </td>
                <td>
                  <Select
                    label={`Dauer: ${t.title}`}
                    size="sm"
                    variant="ghost"
                    value={t.durationMin ?? 0}
                    options={[
                      { value: 0, label: '–' },
                      ...[...new Set([...DURATIONS, ...(t.durationMin ? [t.durationMin] : [])])]
                        .sort((a, b) => a - b)
                        .map((d) => ({ value: d, label: d < 60 ? `${d} Min.` : `${(d / 60).toLocaleString('de-DE')} Std.` })),
                    ]}
                    onChange={(v) => void updateTask(t.id, { durationMin: v || null })}
                  />
                </td>
                <td>
                  <Select
                    label={`Priorität: ${t.title}`}
                    size="sm"
                    variant="ghost"
                    value={t.priority}
                    options={[1, 2, 3, 4].map((p) => ({ value: p, label: p === 4 ? '–' : `P${p}`, icon: <IconFlag size={13} style={{ color: PRIORITY_COLOR[p] }} /> }))}
                    onChange={(v) => void updateTask(t.id, { priority: v })}
                  />
                </td>
                <td className="muted small">{t.labels.map((l) => `@${l}`).join(' ')}</td>
                <td>{who ? <Avatar name={who.name} src={who.avatar} size={20} seed={who.userId} title={who.name} /> : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!sorted.length && <div className="empty">Keine offenen Aufgaben.</div>}
    </div>
  );
}
