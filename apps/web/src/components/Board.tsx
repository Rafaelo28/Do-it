import { addDays, generateKeyBetween, type BoardGroup, type PlainDate } from '@do-it/shared';
import { useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { moveTask, toggleTask, updateTask } from '../lib/actions';
import { useData } from '../lib/data';
import type { Task } from '../lib/db';
import { syncState } from '../lib/sync';
import { useNow } from '../lib/time';
import { Avatar } from './Avatar';
import { IconCheck, IconClock, IconFlag, IconRepeat, IconSubtasks, IconTag } from './Icons';
import { QuickAdd } from './QuickAdd';
import { dueLabel, durationLabel, PRIORITY_COLOR } from './ui';

export interface BoardColumn {
  key: string;
  title: string;
  color?: string;
  /** Aufgabe in diese Spalte gelegt; ohne Funktion nimmt die Spalte nichts an */
  onDrop?: (t: Task, sortKey: string | null) => void;
  /** Schnell-Eingabe in der Spalte */
  add?: { projectId?: string; sectionId?: string; text?: string };
}

const GROUP_LABEL: Record<BoardGroup, string> = { section: 'Abschnitt', project: 'Projekt', priority: 'Priorität', date: 'Fälligkeit' };

/** Board mit wählbarer Gruppierung; berechnet Spalten und was beim Ablegen passiert. */
export function BoardLayout({ tasks, group, groups, onGroup, projectId }: { tasks: Task[]; group: BoardGroup; groups: BoardGroup[]; onGroup: (g: BoardGroup) => void; projectId?: string }) {
  const { sections, projects, projectMap } = useData();
  const members = syncState.select((s) => s.members);
  const now = useNow();
  const g = groups.includes(group) ? group : groups[0]!;
  const ids = new Set(tasks.map((t) => t.id));
  const top = tasks.filter((t) => !t.parentId || !ids.has(t.parentId));

  let columns: BoardColumn[];
  let columnOf: (t: Task) => string;
  let sortable = false;
  if (g === 'section' && projectId) {
    const own = sections.filter((s) => s.projectId === projectId);
    columns = [
      { key: '', title: 'Ohne Abschnitt', onDrop: (t, k) => void updateTask(t.id, { sectionId: null, ...(k ? { sortKey: k } : {}) }), add: { projectId } },
      ...own.map((s) => ({ key: s.id, title: s.name, onDrop: (t: Task, k: string | null) => void updateTask(t.id, { sectionId: s.id, ...(k ? { sortKey: k } : {}) }), add: { projectId, sectionId: s.id } })),
    ];
    columnOf = (t) => (t.sectionId && own.some((s) => s.id === t.sectionId) ? t.sectionId : '');
    sortable = true;
  } else if (g === 'priority') {
    columns = ([1, 2, 3, 4] as const).map((p) => ({
      key: String(p),
      title: p === 4 ? 'Keine Priorität' : `Priorität ${p}`,
      color: PRIORITY_COLOR[p],
      onDrop: (t: Task) => void updateTask(t.id, { priority: p }),
      add: { projectId, text: p === 4 ? '' : `!${p} ` },
    }));
    columnOf = (t) => String(t.priority);
  } else if (g === 'date') {
    const today = now.date;
    const set = (d: PlainDate | null) => (t: Task) => void updateTask(t.id, d ? { dueDate: d } : { dueDate: null, dueTime: null });
    columns = [
      { key: 'over', title: 'Überfällig', color: 'var(--danger)' },
      { key: 'today', title: 'Heute', onDrop: set(today), add: { projectId, text: 'heute ' } },
      { key: 'tomorrow', title: 'Morgen', onDrop: set(addDays(today, 1)), add: { projectId, text: 'morgen ' } },
      { key: 'week', title: 'Nächste 7 Tage', onDrop: set(addDays(today, 2)), add: { projectId, text: 'übermorgen ' } },
      { key: 'later', title: 'Später', onDrop: set(addDays(today, 8)), add: { projectId, text: 'in 8 Tagen ' } },
      { key: 'none', title: 'Ohne Datum', onDrop: set(null), add: { projectId } },
    ];
    columnOf = (t) =>
      !t.dueDate ? 'none' : t.dueDate < today ? 'over' : t.dueDate === today ? 'today' : t.dueDate === addDays(today, 1) ? 'tomorrow' : t.dueDate <= addDays(today, 7) ? 'week' : 'later';
  } else {
    const used = new Set(top.map((t) => t.projectId));
    columns = projects
      .filter((p) => !p.archived && (used.has(p.id) || p.isInbox))
      .map((p) => ({
        key: p.id,
        title: p.isInbox ? 'Eingang' : p.name,
        color: p.isInbox ? undefined : (p.color ?? undefined),
        onDrop: (t: Task) =>
          void moveTask(
            t.id,
            p.id,
            members.filter((m) => m.projectId === p.id).map((m) => m.userId),
          ),
        add: { projectId: p.id },
      }));
    columnOf = (t) => (projectMap.has(t.projectId) ? t.projectId : '');
  }

  return (
    <>
      {groups.length > 1 && (
        <div className="row small muted" style={{ gap: 8, margin: '4px 0 10px' }}>
          Gruppieren nach
          <select className="input" style={{ width: 'auto', minHeight: 32, padding: '4px 8px' }} value={g} onChange={(e) => onGroup(e.target.value as BoardGroup)}>
            {groups.map((x) => (
              <option key={x} value={x}>
                {GROUP_LABEL[x]}
              </option>
            ))}
          </select>
        </div>
      )}
      <Board tasks={top} columns={columns} columnOf={columnOf} sortable={sortable} />
    </>
  );
}

interface Drag {
  task: Task;
  x: number;
  y: number;
  active: boolean;
  over: string | null;
  index: number;
}

export function Board({ tasks, columns, columnOf, sortable }: { tasks: Task[]; columns: BoardColumn[]; columnOf: (t: Task) => string; sortable: boolean }) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const ref = useRef<Drag | null>(null);
  const suppress = useRef(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [, navigate] = useLocation();
  const { childStats } = useData();
  const members = syncState.select((s) => s.members);
  const me = syncState.select((s) => s.me);
  const now = useNow();

  const byColumn = new Map<string, Task[]>(columns.map((c) => [c.key, []]));
  for (const t of tasks) byColumn.get(columnOf(t))?.push(t);
  for (const list of byColumn.values()) list.sort((a, b) => (sortable ? (a.sortKey < b.sortKey ? -1 : 1) : (a.dueDate ?? '9').localeCompare(b.dueDate ?? '9') || a.priority - b.priority));

  function start(e: React.PointerEvent, task: Task) {
    if (e.pointerType === 'touch' || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    ref.current = { task, x: e.clientX, y: e.clientY, active: false, over: null, index: 0 };
    const move = (ev: PointerEvent) => {
      const cur = ref.current;
      if (!cur) return;
      if (!cur.active && Math.hypot(ev.clientX - cur.x, ev.clientY - cur.y) < 5) return;
      const col = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-board-col]');
      const key = col?.dataset.boardCol ?? null;
      let index = 0;
      if (col) {
        const cards = [...col.querySelectorAll<HTMLElement>('[data-board-card]')].filter((c) => c.dataset.boardCard !== cur.task.id);
        index = cards.filter((c) => {
          const r = c.getBoundingClientRect();
          return r.top + r.height / 2 < ev.clientY;
        }).length;
      }
      ref.current = { ...cur, active: true, over: key, index };
      setDrag(ref.current);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const cur = ref.current;
      ref.current = null;
      setDrag(null);
      if (!cur?.active) return;
      suppress.current = true;
      setTimeout(() => (suppress.current = false), 0);
      const col = columns.find((c) => c.key === cur.over);
      if (!col?.onDrop) return;
      const same = columnOf(cur.task) === col.key;
      let sortKey: string | null = null;
      if (sortable) {
        const list = (byColumn.get(col.key) ?? []).filter((t) => t.id !== cur.task.id);
        const before = list[cur.index - 1]?.sortKey ?? null;
        const after = list[cur.index]?.sortKey ?? null;
        try {
          sortKey = generateKeyBetween(before, after);
        } catch {
          sortKey = null;
        }
      }
      if (!same || sortKey) col.onDrop(cur.task, sortKey);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  const nameOf = (id: string | null) => members.find((m) => m.userId === id);

  return (
    <div className="board">
      {columns.map((c) => {
        const list = byColumn.get(c.key) ?? [];
        const isOver = drag?.active && drag.over === c.key && !!c.onDrop;
        return (
          <section key={c.key} className={`board-col ${isOver ? 'over' : ''}`} data-board-col={c.key}>
            <div className="board-col-head">
              {c.color && <span className="dot" style={{ background: c.color }} />}
              <span className="board-col-title">{c.title}</span>
              <span className="muted">{list.length || ''}</span>
            </div>
            <div className="board-cards">
              {list.map((t, i) => {
                const stats = childStats.get(t.id);
                const who = nameOf(t.assigneeId);
                return (
                  <div key={t.id}>
                    {isOver && drag!.index === i && <div className="board-drop-line" />}
                    <article
                      className={`board-card ${drag?.active && drag.task.id === t.id ? 'dragging' : ''}`}
                      data-board-card={t.id}
                      style={{ '--pc': PRIORITY_COLOR[t.priority] } as React.CSSProperties}
                      onPointerDown={(e) => start(e, t)}
                      onClick={() => !suppress.current && navigate(`/task/${t.id}`)}
                    >
                      <button
                        className="check"
                        style={{ '--pc': PRIORITY_COLOR[t.priority] } as React.CSSProperties}
                        aria-label="Erledigt"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (me) void toggleTask(t, me);
                        }}
                      >
                        <IconCheck size={12} />
                      </button>
                      <div className="board-card-body">
                        <div className="board-card-title">{t.title}</div>
                        <div className="meta">
                          {t.dueDate && (
                            <span className={t.dueDate < now.date ? 'overdue' : ''}>
                              {t.recurrence ? <IconRepeat size={12} /> : <IconClock size={12} />} {dueLabel(t.dueDate, t.dueTime, now.date)}
                            </span>
                          )}
                          {t.deadline && (
                            <span className={t.deadline < now.date ? 'overdue' : ''}>
                              <IconFlag size={12} /> {dueLabel(t.deadline, null, now.date)}
                            </span>
                          )}
                          {t.durationMin && <span>{durationLabel(t.durationMin)}</span>}
                          {stats && (
                            <span>
                              <IconSubtasks size={12} /> {stats.done}/{stats.total}
                            </span>
                          )}
                          {t.labels.map((l) => (
                            <span key={l}>
                              <IconTag size={12} />
                              {l}
                            </span>
                          ))}
                          {who && <Avatar name={who.name} src={who.avatar} size={18} seed={who.userId} title={who.name} />}
                        </div>
                      </div>
                    </article>
                  </div>
                );
              })}
              {isOver && drag!.index >= list.filter((t) => t.id !== drag!.task.id).length && <div className="board-drop-line" />}
            </div>
            {c.add &&
              (adding === c.key ? (
                <QuickAdd autoFocus projectId={c.add.projectId} sectionId={c.add.sectionId} initialText={c.add.text} onDone={() => setAdding(null)} />
              ) : (
                <button className="btn ghost small muted board-add" onClick={() => setAdding(c.key)}>
                  + Aufgabe
                </button>
              ))}
          </section>
        );
      })}
    </div>
  );
}
