import { parseTask } from '@do-it/parser';
import { addDays, describeRecurrence, formatDateRelative, isoWeekday, startOfIsoWeek, type TaskData } from '@do-it/shared';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { Avatar } from '../components/Avatar';
import { IconBack, IconBell, IconCheck, IconTrash, IconX } from '../components/Icons';
import { QuickAdd } from '../components/QuickAdd';
import { TaskList } from '../components/TaskList';
import { PRIORITY_COLOR, reminderLabel } from '../components/ui';
import { addComment, addReminder, deleteComment, deleteReminder, deleteTask, ensureLabels, moveTask, toggleTask, updateTask } from '../lib/actions';
import { useData } from '../lib/data';
import { db, type Task } from '../lib/db';
import { syncState } from '../lib/sync';
import { useNow } from '../lib/time';

export function TaskDetail({ id }: { id: string }) {
  const { tasks, loaded } = useData();
  const task = tasks.find((t) => t.id === id);
  const [, navigate] = useLocation();
  if (!task) {
    return (
      <div className="page">
        {loaded && (
          <div className="empty">
            Diese Aufgabe gibt es nicht (mehr).
            <div style={{ marginTop: 12 }}>
              <button className="btn" onClick={() => navigate('/today')}>
                Zu „Heute“
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }
  return <Detail task={task} key={task.id} />;
}

function Detail({ task }: { task: Task }) {
  const { projects, projectMap, sections, tasks, reminders } = useData();
  const { me, members } = syncState.use();
  const now = useNow();
  const [, navigate] = useLocation();
  const [title, setTitle] = useState(task.title);
  const [desc, setDesc] = useState(task.description);
  const [recText, setRecText] = useState('');
  const [labelText, setLabelText] = useState('');
  const [comment, setComment] = useState('');
  const [remKind, setRemKind] = useState('0');
  const [remAt, setRemAt] = useState('');
  const comments = useLiveQuery(() => db.comments.where('taskId').equals(task.id).sortBy('createdAt'), [task.id]) ?? [];

  useEffect(() => setTitle(task.title), [task.title]);
  useEffect(() => setDesc(task.description), [task.description]);

  const project = projectMap.get(task.projectId);
  const projectMembers = members.filter((m) => m.projectId === task.projectId);
  const role = projectMembers.find((m) => m.userId === me?.id)?.role;
  const readOnly = role === 'viewer';
  const children = tasks.filter((t) => t.parentId === task.id);
  const myReminders = reminders.filter((r) => r.taskId === task.id);
  const nameOf = (uid: string | null) => members.find((m) => m.userId === uid)?.name ?? 'Unbekannt';
  const avatarOf = (uid: string | null) => members.find((m) => m.userId === uid)?.avatar ?? null;
  const recParse = recText ? parseTask(recText, { today: now.date, now: now.time }) : null;

  const set = (changes: Partial<TaskData>) => void updateTask(task.id, changes);

  function goBack() {
    if (history.length > 1) history.back();
    else navigate(`/project/${task.projectId}`);
  }

  async function addLabel() {
    const name = labelText.trim().replace(/^@/, '');
    // sofort leeren: ein gleich folgender Fokuswechsel (onBlur) legt sonst dasselbe Label noch einmal an
    setLabelText('');
    if (!name || task.labels.some((l) => l.toLowerCase() === name.toLowerCase())) return;
    set({ labels: [...task.labels, name] });
    await ensureLabels([name]);
  }

  async function addRem() {
    if (remKind === 'abs') {
      if (!remAt) return;
      const [date, time] = remAt.split('T') as [string, string];
      await addReminder({ taskId: task.id, kind: 'absolute', offsetMin: null, date, time: time.slice(0, 5) });
      setRemAt('');
    } else {
      await addReminder({ taskId: task.id, kind: 'relative', offsetMin: Number(remKind), date: null, time: null });
    }
  }

  return (
    <div className="page">
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="btn ghost" onClick={goBack}>
          <IconBack /> Zurück
        </button>
        <span className="muted small">
          {project?.isInbox ? 'Eingang' : project?.name}
          {task.parentId && ' · Unteraufgabe'}
        </span>
      </div>

      <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
        <button
          className={`check ${task.completedAt ? 'done' : ''}`}
          style={{ '--pc': PRIORITY_COLOR[task.priority], marginTop: 6 } as React.CSSProperties}
          aria-label="Erledigt"
          disabled={readOnly}
          onClick={() => me && void toggleTask(task, me)}
        >
          <IconCheck size={13} />
        </button>
        <input
          className="detail-title"
          value={title}
          disabled={readOnly}
          aria-label="Titel"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== task.title && set({ title: title.trim() })}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </div>

      <textarea
        className="input"
        style={{ marginTop: 10 }}
        placeholder="Notizen …"
        value={desc}
        disabled={readOnly}
        onChange={(e) => setDesc(e.target.value)}
        onBlur={() => desc !== task.description && set({ description: desc })}
      />

      <div className="detail-grid">
        <label className="field">
          <span>Datum</span>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input className="input" type="date" value={task.dueDate ?? ''} disabled={readOnly} onChange={(e) => set({ dueDate: e.target.value || null })} />
            <input className="input" type="time" value={task.dueTime ?? ''} disabled={readOnly || !task.dueDate} onChange={(e) => set({ dueTime: e.target.value || null })} style={{ maxWidth: 120 }} />
          </div>
          {!readOnly && (
            <div className="row" style={{ gap: 4 }}>
              {(
                [
                  ['Heute', now.date],
                  ['Morgen', addDays(now.date, 1)],
                  ['Wochenende', isoWeekday(now.date) >= 6 ? now.date : addDays(startOfIsoWeek(now.date), 5)],
                  ['Nächste Woche', addDays(startOfIsoWeek(now.date), 7)],
                ] as const
              ).map(([label, d]) => (
                <button key={label} className="chip" style={{ cursor: 'pointer' }} onClick={() => set({ dueDate: d })}>
                  {label}
                </button>
              ))}
            </div>
          )}
          {task.dueDate && (
            <span className="small">
              {formatDateRelative(task.dueDate, now.date)}
              {!readOnly && (
                <button className="btn ghost small" style={{ minHeight: 0, padding: '0 6px' }} onClick={() => set({ dueDate: null, dueTime: null, recurrence: null })}>
                  entfernen
                </button>
              )}
            </span>
          )}
        </label>

        <label className="field">
          <span>Wiederholung</span>
          {task.recurrence ? (
            <div className="row">
              <span style={{ color: 'var(--text)' }}>{describeRecurrence(task.recurrence)}</span>
              {!readOnly && (
                <button className="btn ghost small" onClick={() => set({ recurrence: null })}>
                  entfernen
                </button>
              )}
            </div>
          ) : (
            <input className="input" placeholder="z. B. „jeden Montag“, „alle 2 Wochen“" value={recText} disabled={readOnly} onChange={(e) => setRecText(e.target.value)} />
          )}
          {recParse?.recurrence && (
            <button
              className="btn small"
              onClick={() => {
                set({ recurrence: recParse.recurrence, dueDate: task.dueDate ?? recParse.dueDate, dueTime: task.dueTime ?? recParse.dueTime });
                setRecText('');
              }}
            >
              Übernehmen: {describeRecurrence(recParse.recurrence)}
            </button>
          )}
          {recText && !recParse?.recurrence && <span className="small">Noch nicht verstanden …</span>}
        </label>

        <label className="field">
          <span>Projekt</span>
          <select className="input" value={task.projectId} disabled={readOnly || !!task.parentId} onChange={(e) => void moveTask(task.id, e.target.value, members.filter((m) => m.projectId === e.target.value).map((m) => m.userId))}>
            {projects
              .filter((p) => !p.archived || p.id === task.projectId)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.isInbox ? 'Eingang' : p.name}
                </option>
              ))}
          </select>
        </label>

        <label className="field">
          <span>Abschnitt</span>
          <select className="input" value={task.sectionId ?? ''} disabled={readOnly} onChange={(e) => set({ sectionId: e.target.value || null })}>
            <option value="">—</option>
            {sections
              .filter((s) => s.projectId === task.projectId)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </label>

        <label className="field">
          <span>Priorität</span>
          <select className="input" value={task.priority} disabled={readOnly} onChange={(e) => set({ priority: Number(e.target.value) as 1 | 2 | 3 | 4 })}>
            <option value={1}>P1 – dringend</option>
            <option value={2}>P2 – wichtig</option>
            <option value={3}>P3</option>
            <option value={4}>Keine</option>
          </select>
        </label>

        <label className="field">
          <span>Zuständig</span>
          <select className="input" value={task.assigneeId ?? ''} disabled={readOnly} onChange={(e) => set({ assigneeId: e.target.value || null })}>
            <option value="">Niemand</option>
            {projectMembers.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </select>
          {task.rotation.length > 1 && (
            <span className="small">
              Abwechselnd: {task.rotation.map(nameOf).join(' → ')}{' '}
              {!readOnly && (
                <button className="btn ghost small" style={{ minHeight: 0, padding: '0 6px' }} onClick={() => set({ rotation: [] })}>
                  beenden
                </button>
              )}
            </span>
          )}
        </label>

        <label className="field">
          <span>Deadline</span>
          <input className="input" type="date" value={task.deadline ?? ''} disabled={readOnly} onChange={(e) => set({ deadline: e.target.value || null })} />
        </label>

        <label className="field">
          <span>Dauer (Minuten)</span>
          <input
            className="input"
            type="number"
            min={1}
            inputMode="numeric"
            value={task.durationMin ?? ''}
            disabled={readOnly}
            onChange={(e) => set({ durationMin: e.target.value ? Math.max(1, Math.round(Number(e.target.value))) : null })}
          />
        </label>
      </div>

      <h2>Labels</h2>
      <div className="row">
        {task.labels.map((l) => (
          <button
            key={l}
            className="chip"
            style={{ '--chip': 'var(--hl-label)' } as React.CSSProperties}
            disabled={readOnly}
            aria-label={`Label ${l} entfernen`}
            onClick={() => set({ labels: task.labels.filter((x) => x !== l) })}
          >
            @{l} {!readOnly && <IconX size={12} />}
          </button>
        ))}
        {!readOnly && (
          <input
            className="input"
            style={{ maxWidth: 200 }}
            placeholder="Label hinzufügen"
            value={labelText}
            onChange={(e) => setLabelText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void addLabel()}
            onBlur={() => void addLabel()}
          />
        )}
      </div>

      <h2>
        <IconBell size={16} /> Erinnerungen
      </h2>
      <ul className="list-plain">
        {myReminders.map((r) => (
          <li key={r.id}>
            <span style={{ flex: 1 }}>{r.kind === 'relative' ? reminderLabel(r.offsetMin) : `${formatDateRelative(r.date!, now.date)} ${r.time}`}</span>
            <button className="icon-btn" aria-label="Erinnerung löschen" onClick={() => void deleteReminder(r.id)}>
              <IconTrash size={16} />
            </button>
          </li>
        ))}
      </ul>
      <div className="row" style={{ marginTop: 8 }}>
        <select className="input" style={{ width: 'auto' }} value={remKind} onChange={(e) => setRemKind(e.target.value)}>
          <option value="0">Zur Fälligkeit</option>
          <option value="10">10 Min. vorher</option>
          <option value="30">30 Min. vorher</option>
          <option value="60">1 Std. vorher</option>
          <option value="180">3 Std. vorher</option>
          <option value="1440">1 Tag vorher</option>
          <option value="abs">Zu einem Zeitpunkt …</option>
        </select>
        {remKind === 'abs' && <input className="input" type="datetime-local" style={{ width: 'auto' }} value={remAt} onChange={(e) => setRemAt(e.target.value)} />}
        <button className="btn" onClick={() => void addRem()} disabled={remKind !== 'abs' && !task.dueDate}>
          Hinzufügen
        </button>
      </div>
      {!task.dueDate && remKind !== 'abs' && <p className="small muted">Für Erinnerungen „vorher“ braucht die Aufgabe ein Datum.</p>}

      <h2>Unteraufgaben</h2>
      <TaskList tasks={children} showProject={false} showSubtasks={false} />
      {!readOnly && (
        <div style={{ marginTop: 8 }}>
          <QuickAdd projectId={task.projectId} sectionId={task.sectionId} parentId={task.id} placeholder="Unteraufgabe hinzufügen" />
        </div>
      )}

      <h2>Kommentare</h2>
      <div style={{ display: 'grid', gap: 10 }}>
        {comments.map((c) => (
          <div key={c.id} className="comment">
            <div className="small muted comment-head">
              <Avatar name={nameOf(c.authorId)} src={avatarOf(c.authorId)} size={20} seed={c.authorId} />
              {nameOf(c.authorId)} · {new Date(c.createdAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}
              {c.authorId === me?.id && (
                <button className="btn ghost small" style={{ minHeight: 0, padding: '0 6px' }} onClick={() => void deleteComment(c.id)}>
                  löschen
                </button>
              )}
            </div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
          </div>
        ))}
        <textarea className="input" placeholder="Kommentar schreiben …" value={comment} onChange={(e) => setComment(e.target.value)} style={{ minHeight: 60 }} />
        <div>
          <button
            className="btn"
            disabled={!comment.trim()}
            onClick={() => {
              if (me) void addComment(task.id, comment.trim(), me);
              setComment('');
            }}
          >
            Kommentieren
          </button>
        </div>
      </div>

      <div className="row" style={{ marginTop: 28 }}>
        {!readOnly && (
          <button
            className="btn danger"
            onClick={() => {
              if (!confirm('Aufgabe löschen?')) return;
              void deleteTask(task);
              goBack();
            }}
          >
            <IconTrash size={16} /> Löschen
          </button>
        )}
        <span className="small muted" style={{ marginLeft: 'auto' }}>
          {task.createdBy && `Angelegt von ${nameOf(task.createdBy)} · `}
          {new Date(task.createdAt).toLocaleDateString('de-DE')}
          {task.lastCompletedAt && ` · zuletzt erledigt ${new Date(task.lastCompletedAt).toLocaleDateString('de-DE')} von ${nameOf(task.lastCompletedBy)}`}
        </span>
      </div>
    </div>
  );
}
