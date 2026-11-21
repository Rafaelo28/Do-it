import { applyFilter, FILTER_EXAMPLES, uuidv7, type FilterContext, type SavedFilter } from '@do-it/shared';
import { useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { IconPencil, IconWarn } from '../components/Icons';
import { LayoutSwitch } from '../components/LayoutSwitch';
import { byDue, TaskList } from '../components/TaskList';
import { Modal } from '../components/ui';
import { useData } from '../lib/data';
import type { Task } from '../lib/db';
import { toast } from '../lib/store';
import { syncState } from '../lib/sync';
import { useNow } from '../lib/time';
import { updateSettings, useViewPref } from '../lib/views';
import { LayoutBody } from './Layouted';

const COLORS = ['#0f8b6c', '#3e63dd', '#e5484d', '#f76b15', '#8e4ec6', '#12a594', '#d6409f', '#978365'];

/** Alles, was die Filtersprache über Projekte, Abschnitte und Personen wissen muss. */
export function useFilterContext(): FilterContext | null {
  const { projects, sections } = useData();
  const me = syncState.select((s) => s.me);
  const members = syncState.select((s) => s.members);
  const now = useNow();
  return useMemo(
    () =>
      me
        ? {
            today: now.date,
            meId: me.id,
            projects: projects.map((p) => ({ id: p.id, name: p.name, parentId: p.parentId, isInbox: p.isInbox })),
            sections: sections.map((s) => ({ id: s.id, name: s.name })),
            members: members.map((m) => ({ userId: m.userId, name: m.name })),
          }
        : null,
    [me, now.date, projects, sections, members],
  );
}

export function filterTasks(tasks: Task[], query: string, ctx: FilterContext | null): { tasks: Task[]; error: string | null } {
  if (!ctx) return { tasks: [], error: null };
  return applyFilter(tasks, query, ctx);
}

export function CustomFilterView({ id }: { id: string }) {
  const filters = syncState.select((s) => s.me?.settings.filters);
  const { tasks, loaded } = useData();
  const ctx = useFilterContext();
  const [editing, setEditing] = useState(false);
  const [pref, setPref] = useViewPref(`filter:${id}`, { layout: 'list', group: 'project' });
  const f = filters?.find((x) => x.id === id);
  const result = useMemo(() => (f ? filterTasks(tasks, f.query, ctx) : { tasks: [], error: null }), [f, tasks, ctx]);
  if (!f) return <div className="page">{loaded && filters && <div className="empty">Diesen Filter gibt es nicht mehr.</div>}</div>;
  const list = [...result.tasks].sort(byDue);
  const layout = pref.layout ?? 'list';

  return (
    <div className={`page ${layout !== 'list' ? 'wide' : ''}`}>
      <div className="page-head">
        <span className="dot" style={{ background: f.color ?? 'var(--accent)', width: 14, height: 14 }} />
        <h1>{f.name}</h1>
        <span className="sub">{list.length} offen</span>
        <div className="actions">
          <LayoutSwitch value={layout} onChange={(l) => setPref({ layout: l })} />
          <button className="icon-btn" aria-label="Filter bearbeiten" onClick={() => setEditing(true)}>
            <IconPencil />
          </button>
        </div>
      </div>
      <code className="filter-query small muted">{f.query}</code>
      {result.error ? (
        <p className="error-text row" style={{ gap: 6 }}>
          <IconWarn size={14} /> {result.error}
        </p>
      ) : (
        <LayoutBody
          prefKey={`filter:${id}`}
          pref={{ ...pref, layout }}
          setPref={setPref}
          tasks={list}
          groups={['project', 'priority', 'date']}
          list={list.length ? <TaskList tasks={list} /> : <div className="empty">Gerade passt keine offene Aufgabe zu diesem Filter.</div>}
        />
      )}
      {editing && <FilterEditor filter={f} onClose={() => setEditing(false)} />}
    </div>
  );
}

/** Filter anlegen oder bearbeiten – mit Vorschau, wie viele Aufgaben passen. */
export function FilterEditor({ filter, onClose }: { filter?: SavedFilter; onClose: () => void }) {
  const [name, setName] = useState(filter?.name ?? '');
  const [query, setQuery] = useState(filter?.query ?? '');
  const [color, setColor] = useState(filter?.color ?? COLORS[0]!);
  const { tasks } = useData();
  const ctx = useFilterContext();
  const [, navigate] = useLocation();
  const result = useMemo(() => (query.trim() ? filterTasks(tasks, query, ctx) : null), [query, tasks, ctx]);

  async function save() {
    const all = syncState.get().me?.settings.filters ?? [];
    if (!filter && all.length >= 150) return toast('Höchstens 150 eigene Filter', { kind: 'error' });
    const next: SavedFilter = { id: filter?.id ?? uuidv7(), name: name.trim(), query: query.trim(), color };
    await updateSettings({ filters: filter ? all.map((x) => (x.id === filter.id ? next : x)) : [...all, next] });
    onClose();
    if (!filter) navigate(`/f/${next.id}`);
  }

  async function remove() {
    if (!filter || !confirm(`Filter „${filter.name}“ löschen? Aufgaben bleiben erhalten.`)) return;
    const all = syncState.get().me?.settings.filters ?? [];
    await updateSettings({ filters: all.filter((x) => x.id !== filter.id) });
    onClose();
    navigate('/today');
  }

  return (
    <Modal onClose={onClose} label={filter ? 'Filter bearbeiten' : 'Neuer Filter'}>
      <div style={{ display: 'grid', gap: 12 }}>
        <strong>{filter ? 'Filter bearbeiten' : 'Neuer Filter'}</strong>
        <label className="field">
          <span>Name</span>
          <input className="input" autoFocus={!filter} maxLength={60} placeholder="z. B. Diese Woche wichtig" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>Abfrage</span>
          <input
            className="input filter-input"
            maxLength={500}
            spellCheck={false}
            placeholder="z. B. (heute | überfällig) & p1"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {result && (
          <div className={`small ${result.error ? 'error-text' : 'muted'}`}>
            {result.error ? (
              <span className="row" style={{ gap: 6 }}>
                <IconWarn size={14} /> {result.error}
              </span>
            ) : (
              <>
                {result.tasks.length === 1 ? '1 offene Aufgabe passt' : `${result.tasks.length} offene Aufgaben passen`}
                {result.tasks.length > 0 && `: ${result.tasks.slice(0, 4).map((t) => t.title).join(', ')}${result.tasks.length > 4 ? ' …' : ''}`}
              </>
            )}
          </div>
        )}
        <div className="row" style={{ gap: 6 }}>
          {COLORS.map((c) => (
            <button key={c} className={`color-dot ${c === color ? 'on' : ''}`} style={{ background: c }} aria-label={`Farbe ${c}`} onClick={() => setColor(c)} />
          ))}
        </div>
        <details className="small">
          <summary>So funktionieren Abfragen</summary>
          <div className="filter-help">
            <p className="muted">
              Verknüpfen mit <code>&amp;</code> (und), <code>|</code> (oder), <code>!</code> (nicht) und Klammern. Todoist-Schreibweisen wie <code>today</code>,{' '}
              <code>overdue</code> oder <code>no date</code> gehen auch.
            </p>
            <ul>
              <li>
                <b>Datum:</b> heute, morgen, überfällig, ohne datum, 7 tage, diese woche, nächste woche, wochenende, vor: 24.12., nach: heute
              </li>
              <li>
                <b>Deadline:</b> deadline, deadline 7 tage, deadline überfällig, ohne deadline
              </li>
              <li>
                <b>Priorität:</b> p1 … p4
              </li>
              <li>
                <b>Projekt, Abschnitt, Label:</b> #Arbeit, ##Arbeit (mit Unterprojekten), /Später, @einkaufen, #Haus* (Platzhalter)
              </li>
              <li>
                <b>Personen:</b> mir zugewiesen, zugewiesen an: Ben, nicht zugewiesen, von mir erstellt
              </li>
              <li>
                <b>Sonstiges:</b> wiederkehrend, unteraufgaben, mit uhrzeit, mit dauer, suche: rechnung
              </li>
            </ul>
            <div className="chips">
              {FILTER_EXAMPLES.map((ex) => (
                <button key={ex.query} className="chip suggest" title={ex.text} onClick={() => setQuery(ex.query)}>
                  {ex.query}
                </button>
              ))}
            </div>
          </div>
        </details>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          {filter ? (
            <button className="btn ghost danger" onClick={() => void remove()}>
              Löschen
            </button>
          ) : (
            <span />
          )}
          <div className="row">
            <button className="btn ghost" onClick={onClose}>
              Abbrechen
            </button>
            <button className="btn primary" disabled={!name.trim() || !query.trim() || !!result?.error} onClick={() => void save()}>
              Speichern
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
