import { markdownToText, noteTaskIds, noteTitle } from '@do-it/shared';
import { fold } from '@do-it/parser';
import { useMemo, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { IconCheck, IconChevronLeft, IconDownload, IconMore, IconNote, IconOutline, IconPin, IconPlus, IconSearch, IconSidebar, IconSubtasks, IconTrash } from '../components/Icons';
import { MenuButton } from '../components/Menu';
import { NoteEditor, type SaveState } from '../components/NoteEditor';
import { Dot, projectOptions, Select } from '../components/Select';
import { useData } from '../lib/data';
import type { Note } from '../lib/db';
import { NARROW, useMedia } from '../lib/media';
import { NOTE_GROUP_LABEL, noteGroup, type NoteGroup } from '../lib/noteMarkdown';
import { createNote, deleteNote, editedLabel, exportMarkdown, sortNotes, updateNote, useNote, useNotes } from '../lib/notes';
import { syncState } from '../lib/sync';
import { useNow } from '../lib/time';

/** kleine Vorlieben nur für dieses Gerät */
function useLocalFlag(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => {
    try {
      const s = localStorage.getItem(key);
      return s === null ? initial : s === '1';
    } catch {
      return initial;
    }
  });
  return [
    v,
    (next) => {
      setV(next);
      try {
        localStorage.setItem(key, next ? '1' : '0');
      } catch {
        // egal
      }
    },
  ];
}

/** Notizen: Liste links, Notiz rechts (Handy: erst Liste, dann Notiz). Die Liste lässt sich zum Schreiben ausblenden. */
export function NotesPage({ id }: { id?: string }) {
  const narrow = useMedia('(max-width: 1000px)');
  const phone = useMedia(NARROW);
  const [listHidden, setListHidden] = useLocalFlag('doit-notes-list-hidden', false);
  const focus = !narrow && !!id && listHidden;
  const showList = narrow ? !id : !focus;
  const showEditor = !narrow || !!id;
  return (
    <div className={`page wide notes-page ${id ? 'has-note' : ''} ${phone ? 'phone' : ''} ${focus ? 'focus' : ''}`}>
      <div className="notes-layout">
        {showList && <NotesList activeId={id} />}
        {showEditor &&
          (id ? (
            <NotePane id={id} narrow={narrow} listHidden={listHidden} onToggleList={() => setListHidden(!listHidden)} />
          ) : (
            <div className="notes-empty">
              <IconNote size={34} />
              <p className="muted">Wähle links eine Notiz aus oder lege eine neue an.</p>
            </div>
          ))}
      </div>
    </div>
  );
}

function NotesList({ activeId }: { activeId?: string }) {
  const notes = useNotes();
  const { projects, projectMap, inbox, tasks } = useData();
  const [, navigate] = useLocation();
  const search = useSearch();
  const now = useNow();
  const [q, setQ] = useState('');
  const [project, setProject] = useState(() => new URLSearchParams(search).get('project') ?? '');
  const needle = fold(q.trim());

  const groups = useMemo(() => {
    const visible = (notes ?? []).filter((n) => projectMap.has(n.projectId) && !n.archived && (!project || n.projectId === project));
    // gesucht wird auch in den Titeln eingebetteter Aufgaben
    const taskTitle = new Map(tasks.map((t) => [t.id, t.title]));
    const text = (n: Note) => fold(`${n.title}\n${markdownToText(n.body)}\n${noteTaskIds(n.body).map((id) => taskTitle.get(id) ?? '').join('\n')}`);
    const hits = sortNotes(needle ? visible.filter((n) => text(n).includes(needle)) : visible);
    const out = new Map<NoteGroup, Note[]>();
    for (const n of hits) {
      const g = noteGroup(n, now.date);
      out.set(g, [...(out.get(g) ?? []), n]);
    }
    return [...out.entries()];
  }, [notes, projectMap, project, needle, tasks, now.date]);

  async function add() {
    const target = project || inbox?.id;
    if (!target) return;
    const id = await createNote(target);
    navigate(`/notes/${id}?neu=1`);
  }

  return (
    <aside className="notes-list" aria-label="Notizen">
      <div className="notes-head">
        <h1>Notizen</h1>
        <button className="btn primary small" onClick={() => void add()}>
          <IconPlus size={16} /> Neue Notiz
        </button>
      </div>
      <div className="notes-tools">
        <label className="notes-search">
          <IconSearch size={16} />
          <input className="input" placeholder="Notizen durchsuchen …" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Notizen durchsuchen" />
        </label>
        <Select
          label="Projekt"
          size="sm"
          value={project}
          options={[{ value: '', label: 'Alle Projekte', icon: <IconNote size={15} /> }, ...projectOptions(projects)]}
          onChange={setProject}
        />
      </div>
      {notes && !groups.length && (
        <div className="notes-none small muted">
          {needle ? 'Keine Notiz gefunden.' : 'Noch keine Notizen. Notizen können Text, Checklisten, Tabellen und echte Aufgaben enthalten.'}
        </div>
      )}
      {groups.map(([g, list]) => (
        <section key={g} className="notes-group" aria-label={NOTE_GROUP_LABEL[g]}>
          <div className="notes-group-title">{NOTE_GROUP_LABEL[g]}</div>
          <ul className="notes-items">
            {list.map((n) => (
              <NoteItem key={n.id} n={n} active={n.id === activeId} today={now.date} projectName={projectLabel(projectMap.get(n.projectId))} color={projectMap.get(n.projectId)?.color} />
            ))}
          </ul>
        </section>
      ))}
    </aside>
  );
}

function projectLabel(p: { isInbox: boolean; name: string } | undefined): string | null {
  return !p || p.isInbox ? null : p.name;
}

function NoteItem({ n, active, today, projectName, color }: { n: Note; active: boolean; today: string; projectName: string | null; color?: string | null }) {
  const title = noteTitle(n);
  const text = markdownToText(n.body);
  const snippet = (n.title.trim() ? text : text.slice(title.replace(/…$/, '').length)).trim().slice(0, 140);
  const refs = noteTaskIds(n.body).length;
  return (
    <li>
      <Link href={`/notes/${n.id}`} className={`note-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined}>
        <span className="note-item-title">
          {n.pinned && <IconPin size={13} className="note-pin" aria-label="Angeheftet" />}
          {title}
        </span>
        {snippet && <span className="note-item-snippet">{snippet}</span>}
        <span className="note-item-meta">
          <span>{editedLabel(n.updatedAt, today)}</span>
          {projectName && (
            <span className="row" style={{ gap: 4 }}>
              <Dot color={color} /> {projectName}
            </span>
          )}
          {refs > 0 && (
            <span title="Eingebettete Aufgaben">
              <IconSubtasks size={12} /> {refs}
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}

function NotePane({ id, narrow, listHidden, onToggleList }: { id: string; narrow: boolean; listHidden: boolean; onToggleList: () => void }) {
  const note = useNote(id);
  const { projects, tasks } = useData();
  const [, navigate] = useLocation();
  const search = useSearch();
  const [save, setSave] = useState<SaveState>('saved');
  const [outline, setOutline] = useLocalFlag('doit-notes-outline', false);
  const online = syncState.select((s) => s.status !== 'offline');
  const fresh = new URLSearchParams(search).has('neu');
  if (note === undefined) return <div className="notes-empty muted">Lade …</div>;
  if (note === null)
    return (
      <div className="notes-empty">
        <p className="muted">Diese Notiz gibt es nicht (mehr).</p>
        <Link href="/notes">Zu den Notizen</Link>
      </div>
    );

  function download() {
    const md = exportMarkdown(note!, new Map(tasks.map((t) => [t.id, t])));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
    a.download = `${noteTitle(note!).replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) || 'Notiz'}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function remove() {
    if (!window.confirm(`„${noteTitle(note!)}“ löschen? Eingebettete Aufgaben bleiben bestehen.`)) return;
    await deleteNote(note!.id);
    navigate('/notes', { replace: true });
  }

  const status = save === 'saving' ? 'Speichert …' : online ? 'Gespeichert' : 'Gespeichert (offline, wird später übertragen)';

  return (
    <section className="note-pane" aria-label="Notiz">
      <div className="note-head">
        {narrow ? (
          <Link href="/notes" className="note-back" aria-label="Zurück zu den Notizen">
            <IconChevronLeft size={18} /> Notizen
          </Link>
        ) : (
          <button className={`icon-btn ${listHidden ? '' : 'on'}`} aria-pressed={!listHidden} aria-label={listHidden ? 'Notizliste einblenden' : 'Notizliste ausblenden'} title={listHidden ? 'Notizliste einblenden' : 'Notizliste ausblenden'} onClick={onToggleList}>
            <IconSidebar size={17} />
          </button>
        )}
        <Select label="Projekt" size="sm" variant="ghost" value={note.projectId} options={projectOptions(projects, note.projectId)} onChange={(projectId) => void updateNote(note.id, { projectId })} />
        <span className={`note-save small ${save}`} aria-live="polite">
          {save === 'saved' && <IconCheck size={13} />} {status}
        </span>
        <span className="spacer" />
        <button className={`icon-btn ${outline ? 'on' : ''}`} aria-pressed={outline} aria-label="Gliederung" title="Gliederung" onClick={() => setOutline(!outline)}>
          <IconOutline size={17} />
        </button>
        <button className={`icon-btn ${note.pinned ? 'on' : ''}`} aria-pressed={note.pinned} aria-label={note.pinned ? 'Nicht mehr anheften' : 'Oben anheften'} title={note.pinned ? 'Nicht mehr anheften' : 'Oben anheften'} onClick={() => void updateNote(note.id, { pinned: !note.pinned })}>
          <IconPin size={17} />
        </button>
        <MenuButton
          label="Weitere Aktionen"
          icon={<IconMore size={18} />}
          items={[
            { label: 'Als Markdown herunterladen', icon: <IconDownload size={16} />, onSelect: download },
            { label: 'Notiz löschen', icon: <IconTrash size={16} />, danger: true, separator: true, onSelect: () => void remove() },
          ]}
        />
      </div>
      <NoteEditor key={`${note.id}-${note.projectId}`} note={note} focusTitle={fresh && !note.title} showOutline={outline} onSaveState={setSave} />
    </section>
  );
}
