import { markdownToText, noteTaskIds, noteTitle } from '@do-it/shared';
import { fold } from '@do-it/parser';
import { useMemo, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { IconChevronLeft, IconDownload, IconNote, IconPin, IconPlus, IconSearch, IconSubtasks, IconTrash } from '../components/Icons';
import { NoteEditor } from '../components/NoteEditor';
import { Dot, projectOptions, Select } from '../components/Select';
import { useData } from '../lib/data';
import type { Note } from '../lib/db';
import { NARROW, useMedia } from '../lib/media';
import { createNote, deleteNote, editedLabel, exportMarkdown, sortNotes, updateNote, useNote, useNotes } from '../lib/notes';
import { useNow } from '../lib/time';

/** Notizen: Liste links, Editor rechts (Handy: erst Liste, dann Notiz) */
export function NotesPage({ id }: { id?: string }) {
  const narrow = useMedia('(max-width: 1000px)');
  const phone = useMedia(NARROW);
  const showList = !narrow || !id;
  const showEditor = !narrow || !!id;
  return (
    <div className={`page wide notes-page ${id ? 'has-note' : ''} ${phone ? 'phone' : ''}`}>
      <div className="notes-layout">
        {showList && <NotesList activeId={id} />}
        {showEditor && (id ? <NotePane id={id} /> : <div className="notes-empty muted">Wähle links eine Notiz aus oder lege eine neue an.</div>)}
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

  const list = useMemo(() => {
    const visible = (notes ?? []).filter((n) => projectMap.has(n.projectId) && !n.archived && (!project || n.projectId === project));
    // gesucht wird auch in den Titeln eingebetteter Aufgaben
    const taskTitle = new Map(tasks.map((t) => [t.id, t.title]));
    const text = (n: Note) => fold(`${n.title}\n${markdownToText(n.body)}\n${noteTaskIds(n.body).map((id) => taskTitle.get(id) ?? '').join('\n')}`);
    const hits = needle ? visible.filter((n) => text(n).includes(needle)) : visible;
    return sortNotes(hits);
  }, [notes, projectMap, project, needle, tasks]);

  async function add() {
    const target = project || inbox?.id;
    if (!target) return;
    const id = await createNote(target);
    navigate(`/notes/${id}?neu=1`);
  }

  return (
    <aside className="notes-list" aria-label="Notizen">
      <div className="page-head notes-head">
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
      {notes && !list.length && (
        <div className="empty small">
          {needle ? 'Keine Notiz gefunden.' : 'Noch keine Notizen. Notizen können Text, Checklisten und echte Aufgaben enthalten.'}
        </div>
      )}
      <ul className="notes-items">
        {list.map((n) => (
          <NoteItem key={n.id} n={n} active={n.id === activeId} today={now.date} projectName={projectLabel(projectMap.get(n.projectId))} color={projectMap.get(n.projectId)?.color} />
        ))}
      </ul>
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

function NotePane({ id }: { id: string }) {
  const note = useNote(id);
  const { projects, tasks } = useData();
  const [, navigate] = useLocation();
  const search = useSearch();
  const now = useNow();
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

  return (
    <section className="note-pane" aria-label="Notiz">
      <div className="note-head">
        <Link href="/notes" className="note-back" aria-label="Zurück zu den Notizen">
          <IconChevronLeft size={18} /> Notizen
        </Link>
        <Select label="Projekt" size="sm" value={note.projectId} options={projectOptions(projects, note.projectId)} onChange={(projectId) => void updateNote(note.id, { projectId })} />
        <span className="spacer" />
        <button className={`icon-btn ${note.pinned ? 'on' : ''}`} aria-pressed={note.pinned} aria-label={note.pinned ? 'Nicht mehr anheften' : 'Oben anheften'} title={note.pinned ? 'Nicht mehr anheften' : 'Oben anheften'} onClick={() => void updateNote(note.id, { pinned: !note.pinned })}>
          <IconPin size={17} />
        </button>
        <button className="icon-btn" aria-label="Als Markdown herunterladen" title="Als Markdown herunterladen" onClick={download}>
          <IconDownload size={17} />
        </button>
        <button className="icon-btn" aria-label="Notiz löschen" title="Notiz löschen" onClick={() => void remove()}>
          <IconTrash size={17} />
        </button>
      </div>
      <NoteEditor key={`${note.id}-${note.projectId}`} note={note} focusTitle={fresh && !note.title} />
      <div className="note-foot small muted">Zuletzt bearbeitet {editedLabel(note.updatedAt, now.date)}</div>
    </section>
  );
}
