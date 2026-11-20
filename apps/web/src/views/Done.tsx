import { addDays, diffDays, formatDateLong, formatDateRelative } from '@do-it/shared';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { IconCheck, IconCheckCircle, IconHash, IconRepeat } from '../components/Icons';
import { updateTask } from '../lib/actions';
import { api } from '../lib/api';
import { useData } from '../lib/data';
import { toast } from '../lib/store';
import { syncState } from '../lib/sync';
import { localDateOf, useNow } from '../lib/time';

interface DoneItem {
  taskId: string;
  title: string;
  projectId: string | null;
  byId: string | null;
  byName: string | null;
  at: string;
  recurring: boolean;
  stillDone: boolean;
  deleted: boolean;
}

const RANGES = [7, 30, 90] as const;

/** Alles, was erledigt wurde – auch jede Erledigung wiederkehrender Aufgaben. */
export function DoneView() {
  const { tasks, projectMap } = useData();
  const me = syncState.select((s) => s.me);
  const lastSync = syncState.select((s) => s.lastSync);
  const now = useNow();
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [items, setItems] = useState<DoneItem[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [onlyMine, setOnlyMine] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<{ items: DoneItem[] }>('GET', `/api/completed?days=${days}`)
      .then((r) => {
        if (cancelled) return;
        setItems(r.items);
        setOffline(false);
      })
      .catch(() => {
        if (cancelled) return;
        setOffline(true);
        // Ohne Verbindung: was lokal als erledigt bekannt ist
        setItems(
          tasks
            .filter((t) => t.completedAt && diffDays(localDateOf(t.completedAt), now.date) < days)
            .map((t) => ({
              taskId: t.id,
              title: t.title,
              projectId: t.projectId,
              byId: t.completedBy,
              byName: null,
              at: t.completedAt!,
              recurring: false,
              stillDone: true,
              deleted: false,
            }))
            .sort((a, b) => (a.at < b.at ? 1 : -1)),
        );
      });
    return () => {
      cancelled = true;
    };
    // nach jeder Synchronisierung neu laden, damit frisch Erledigtes erscheint
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, lastSync]);

  const shown = useMemo(() => (items ?? []).filter((i) => !onlyMine || i.byId === me?.id), [items, onlyMine, me]);
  const groups = useMemo(() => {
    const map = new Map<string, DoneItem[]>();
    for (const i of shown) {
      const d = localDateOf(i.at);
      map.set(d, [...(map.get(d) ?? []), i]);
    }
    return [...map.entries()];
  }, [shown]);

  const count = (fromDate: string) => shown.filter((i) => localDateOf(i.at) >= fromDate).length;
  const weekStart = addDays(now.date, -6);
  const shared = (items ?? []).some((i) => i.byId && i.byId !== me?.id);

  async function reopen(i: DoneItem) {
    await updateTask(i.taskId, { completedAt: null, completedBy: null });
    setItems((list) => (list ?? []).map((x) => (x.taskId === i.taskId ? { ...x, stillDone: false } : x)));
    toast(`„${i.title}“ ist wieder offen`);
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Erledigt</h1>
        <span className="sub">
          Heute {count(now.date)} · 7 Tage {count(weekStart)} · {days} Tage {shown.length}
        </span>
      </div>
      <div className="row" style={{ marginBottom: 8 }}>
        {RANGES.map((r) => (
          <button key={r} className={`btn small ${r === days ? 'primary' : 'ghost'}`} onClick={() => setDays(r)}>
            {r} Tage
          </button>
        ))}
        {shared && (
          <label className="row small muted" style={{ marginLeft: 'auto', gap: 6 }}>
            <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} /> nur meine
          </label>
        )}
      </div>
      {offline && <p className="small muted">Offline: Angezeigt wird nur, was dieses Gerät kennt (ohne wiederkehrende Aufgaben).</p>}
      {items && !shown.length && (
        <div className="empty">
          <div className="big">
            <IconCheckCircle size={40} />
          </div>
          In diesem Zeitraum wurde noch nichts erledigt.
        </div>
      )}
      {groups.map(([date, list]) => {
        const rel = formatDateRelative(date, now.date);
        return (
          <section key={date}>
            <div className="group-head">
              {['Heute', 'Gestern'].includes(rel) ? `${rel} · ${formatDateLong(date)}` : formatDateLong(date)}
              <span className="muted">{list.length}</span>
            </div>
            <ul className="task-list">
              {list.map((i, idx) => {
                const project = i.projectId ? projectMap.get(i.projectId) : undefined;
                const exists = !i.deleted && tasks.some((t) => t.id === i.taskId);
                return (
                  <li key={`${i.taskId}-${i.at}-${idx}`} className="task completed done-item">
                    <span className="check done" style={{ '--pc': 'var(--accent)' } as React.CSSProperties} aria-hidden="true">
                      <IconCheck size={13} />
                    </span>
                    <div className="task-body">
                      <div className="task-title">{exists ? <Link href={`/task/${i.taskId}`}>{i.title}</Link> : i.title}</div>
                      <div className="meta">
                        <span>{new Date(i.at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</span>
                        {i.recurring && (
                          <span>
                            <IconRepeat size={12} /> wiederkehrend
                          </span>
                        )}
                        {project && !project.isInbox && (
                          <span>
                            <IconHash size={12} />
                            {project.name}
                          </span>
                        )}
                        {i.byName && i.byId !== me?.id && <span>von {i.byName}</span>}
                        {!i.stillDone && !i.recurring && !i.deleted && <span>wieder offen</span>}
                        {i.deleted && <span>gelöscht</span>}
                      </div>
                    </div>
                    {i.stillDone && !i.recurring && exists && (
                      <button className="btn ghost small" onClick={() => void reopen(i)}>
                        Wieder öffnen
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
