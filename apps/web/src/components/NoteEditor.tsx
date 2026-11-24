import { parseTask, type ParseContext } from '@do-it/parser';
import { Node, mergeAttributes, type JSONContent, type MarkdownToken } from '@tiptap/core';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from '@tiptap/markdown';
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, useEditorState, type Editor, type NodeViewProps } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { createTaskFromParse, toggleTask } from '../lib/actions';
import { useData } from '../lib/data';
import type { Note } from '../lib/db';
import { updateNote } from '../lib/notes';
import { toast } from '../lib/store';
import { syncState } from '../lib/sync';
import { nowLocal } from '../lib/time';
import {
  IconBold,
  IconCode,
  IconItalic,
  IconLink,
  IconListBullet,
  IconListCheck,
  IconListOrdered,
  IconQuote,
  IconRedo,
  IconRule,
  IconSearch,
  IconStrike,
  IconTaskAdd,
  IconUndo,
  IconX,
} from './Icons';
import { QuickAdd } from './QuickAdd';
import { Select } from './Select';
import { dueLabel, Modal, PRIORITY_COLOR } from './ui';

const SAVE_MS = 700;

// ---------- Eingebettete Aufgabe ----------

/** Eigene Zeile "[[task:<id>]]" im Markdown – im Editor eine echte, abhakbare Aufgabe */
const TaskRef = Node.create<{ projectId?: string }>({
  name: 'taskRef',
  addOptions() {
    return { projectId: undefined };
  },
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-task-id'),
        renderHTML: (a) => ({ 'data-task-id': a.id as string }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-task-ref]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-task-ref': '' })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(TaskRefView);
  },
  markdownTokenizer: {
    name: 'taskRef',
    level: 'block',
    start: (src: string) => {
      const m = /(^|\n)[ \t]*\[\[task:/.exec(src);
      return m ? m.index + m[1]!.length : -1;
    },
    tokenize: (src: string) => {
      const m = /^[ \t]*\[\[task:([0-9a-f-]{36})\]\][ \t]*(?:\n|$)/i.exec(src);
      if (!m) return undefined;
      return { type: 'taskRef', raw: m[0], id: m[1]!.toLowerCase() } as MarkdownToken;
    },
  },
  parseMarkdown: (token: MarkdownToken, h) => h.createNode('taskRef', { id: (token as MarkdownToken & { id: string }).id }, []),
  renderMarkdown: (node: JSONContent) => `[[task:${String(node.attrs?.id ?? '')}]]`,
});

function TaskRefView({ node, deleteNode, extension }: NodeViewProps) {
  const id = node.attrs.id as string;
  const { tasks, projectMap } = useData();
  const me = syncState.select((s) => s.me);
  const [, navigate] = useLocation();
  const task = tasks.find((t) => t.id === id);
  const today = nowLocal().date;
  const noteProject = (extension.options as { projectId?: string }).projectId;
  if (!task) {
    return (
      <NodeViewWrapper className="note-task missing" contentEditable={false}>
        <span className="check" aria-hidden="true" />
        <span className="note-task-title muted">Aufgabe nicht gefunden (gelöscht oder kein Zugriff)</span>
        <button className="icon-btn note-task-remove" aria-label="Aus der Notiz entfernen" onClick={deleteNode}>
          <IconX size={14} />
        </button>
      </NodeViewWrapper>
    );
  }
  const project = projectMap.get(task.projectId);
  const overdue = !task.completedAt && !!task.dueDate && task.dueDate < today;
  return (
    <NodeViewWrapper className={`note-task ${task.completedAt ? 'done' : ''}`} contentEditable={false} data-drag-handle="">
      <button
        className={`check ${task.completedAt ? 'done' : ''}`}
        style={{ '--pc': PRIORITY_COLOR[task.priority] } as React.CSSProperties}
        aria-label={task.completedAt ? `„${task.title}“ wieder öffnen` : `„${task.title}“ erledigt`}
        onClick={() => me && void toggleTask(task, me)}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      </button>
      <button className="note-task-title" onClick={() => navigate(`/task/${task.id}`)}>
        {task.title}
      </button>
      <span className="note-task-meta">
        {task.dueDate && <span className={overdue ? 'overdue' : task.dueDate === today ? 'today' : ''}>{dueLabel(task.dueDate, task.dueTime, today)}</span>}
        {project && task.projectId !== noteProject && <span>{project.isInbox ? 'Eingang' : project.name}</span>}
      </span>
      <button className="icon-btn note-task-remove" aria-label="Aus der Notiz entfernen (Aufgabe bleibt bestehen)" title="Aus der Notiz entfernen – die Aufgabe bleibt bestehen" onClick={deleteNode}>
        <IconX size={14} />
      </button>
    </NodeViewWrapper>
  );
}

// ---------- Editor ----------

function useParseContext(): ParseContext {
  const { projects, labels } = useData();
  const { me, members } = syncState.use();
  return useMemo(() => {
    const now = nowLocal();
    const s = me?.settings;
    const unique = new Map(members.map((m) => [m.userId, { id: m.userId, name: m.name }]));
    return {
      today: now.date,
      now: now.time,
      userId: me?.id,
      projects: projects.filter((p) => !p.archived).map((p) => ({ id: p.id, name: p.name, aliases: p.aliases, isInbox: p.isInbox })),
      members: [...unique.values()],
      labels: labels.map((l) => l.name),
      times: s ? { morning: s.morningTime, noon: s.noonTime, afternoon: s.afternoonTime, evening: s.eveningTime, night: s.nightTime, workEnd: s.workEndTime } : undefined,
    };
  }, [projects, labels, me, members]);
}

export function NoteEditor({ note, focusTitle }: { note: Note; focusTitle?: boolean }) {
  const [title, setTitle] = useState(note.title);
  const [inserting, setInserting] = useState(false);
  /** zuletzt gespeicherter oder geladener Text – zum Erkennen von Änderungen anderer Geräte */
  const saved = useRef({ title: note.title, body: note.body });
  const timer = useRef<{ body?: number; title?: number }>({});
  const editorRef = useRef<Editor | null>(null);
  const me = syncState.select((s) => s.me);
  const ctx = useParseContext();

  const flushBody = () => {
    if (timer.current.body) clearTimeout(timer.current.body);
    timer.current.body = undefined;
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed) return;
    const body = ed.getMarkdown();
    if (body === saved.current.body) return;
    saved.current.body = body;
    void updateNote(note.id, { body });
  };
  const flushTitle = (value = title) => {
    if (timer.current.title) clearTimeout(timer.current.title);
    timer.current.title = undefined;
    if (value === saved.current.title) return;
    saved.current.title = value;
    void updateNote(note.id, { title: value });
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        underline: false,
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TaskRef.configure({ projectId: note.projectId }),
      Placeholder.configure({ placeholder: 'Schreib los … Markdown geht auch: # Überschrift, - Liste, [ ] Checkliste' }),
      Markdown,
    ],
    content: note.body,
    contentType: 'markdown',
    autofocus: focusTitle ? false : 'end',
    editorProps: {
      attributes: { class: 'note-prose', 'aria-label': 'Notiz' },
      // Links mit Strg/Cmd-Klick öffnen (sonst wird im Text bearbeitet)
      handleClick: (_view, _pos, event) => {
        const a = (event.target as HTMLElement).closest('a');
        if (a && (event.metaKey || event.ctrlKey)) {
          // nur normale Web-, Mail- und Telefon-Links öffnen (Notizen können von anderen kommen)
          if (/^(https?:|mailto:|tel:)/i.test(a.href)) window.open(a.href, '_blank', 'noopener,noreferrer');
          return true;
        }
        return false;
      },
    },
    onUpdate: () => {
      if (timer.current.body) clearTimeout(timer.current.body);
      timer.current.body = window.setTimeout(flushBody, SAVE_MS);
    },
  });
  editorRef.current = editor;

  // Änderungen von anderen Geräten übernehmen, solange hier nichts ungespeichert ist
  useEffect(() => {
    if (!editor || note.body === saved.current.body || timer.current.body) return;
    saved.current.body = note.body;
    editor.commands.setContent(note.body, { contentType: 'markdown', emitUpdate: false });
  }, [editor, note.body]);
  useEffect(() => {
    if (note.title === saved.current.title || timer.current.title) return;
    saved.current.title = note.title;
    setTitle(note.title);
  }, [note.title]);

  // beim Verlassen und wenn die App in den Hintergrund geht: sofort speichern
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') {
        flushBody();
        flushTitle(titleRef.current);
      }
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
      flushBody();
      flushTitle(titleRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);
  const titleRef = useRef(title);
  titleRef.current = title;

  function insertTask(id: string) {
    editor?.chain().focus().insertContent([{ type: 'taskRef', attrs: { id } }, { type: 'paragraph' }]).run();
  }

  /** Checkliste unter dem Cursor: offene Punkte werden echte Aufgaben (Datum, #Projekt usw. werden erkannt) */
  async function checklistToTasks() {
    if (!editor || !me) return;
    const { $from } = editor.state.selection;
    let depth = $from.depth;
    while (depth > 0 && $from.node(depth).type.name !== 'taskList') depth--;
    if (depth <= 0) return;
    const list = $from.node(depth);
    const pos = $from.before(depth);
    const open: string[] = [];
    const rest: JSONContent[] = [];
    list.forEach((item) => {
      const text = item.firstChild?.textContent.trim() ?? '';
      if (!text) return;
      if (item.attrs.checked) rest.push(item.toJSON() as JSONContent);
      else open.push(text);
    });
    if (!open.length) {
      toast('Keine offenen Punkte in dieser Checkliste');
      return;
    }
    const ids: string[] = [];
    for (const text of open) {
      const r = parseTask(text, ctx);
      if (!r.title.trim()) continue;
      ids.push(await createTaskFromParse(r, { projectId: note.projectId, me }));
    }
    const content: JSONContent[] = [...ids.map((id) => ({ type: 'taskRef', attrs: { id } })), ...(rest.length ? [{ type: 'taskList', content: rest }] : [])];
    editor.chain().focus().insertContentAt({ from: pos, to: pos + list.nodeSize }, content).run();
    toast(`${ids.length} ${ids.length === 1 ? 'Aufgabe' : 'Aufgaben'} angelegt`);
  }

  return (
    <div className="note-editor">
      <input
        className="note-title"
        value={title}
        placeholder="Titel"
        aria-label="Titel der Notiz"
        autoFocus={focusTitle}
        onChange={(e) => {
          setTitle(e.target.value);
          if (timer.current.title) clearTimeout(timer.current.title);
          const v = e.target.value;
          timer.current.title = window.setTimeout(() => flushTitle(v), SAVE_MS);
        }}
        onBlur={() => flushTitle()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && editor) {
            e.preventDefault();
            // sofort umschalten, damit schnell weitergetippte Zeichen nicht im Titel landen
            editor.view.focus();
            editor.commands.focus('start');
          }
        }}
      />
      {editor && <Toolbar editor={editor} onInsertTask={() => setInserting(true)} onChecklistToTasks={() => void checklistToTasks()} />}
      <EditorContent editor={editor} className="note-body" />
      {inserting && (
        <InsertTaskDialog
          projectId={note.projectId}
          exclude={new Set(editor ? collectRefs(editor) : [])}
          onPick={(id) => {
            setInserting(false);
            insertTask(id);
          }}
          onClose={() => setInserting(false)}
        />
      )}
    </div>
  );
}

function collectRefs(editor: Editor): string[] {
  const ids: string[] = [];
  editor.state.doc.descendants((n) => {
    if (n.type.name === 'taskRef') ids.push(n.attrs.id as string);
  });
  return ids;
}

// ---------- Werkzeugleiste ----------

type Block = 'p' | 'h1' | 'h2' | 'h3';

function Toolbar({ editor, onInsertTask, onChecklistToTasks }: { editor: Editor; onInsertTask: () => void; onChecklistToTasks: () => void }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      block: (e.isActive('heading', { level: 1 }) ? 'h1' : e.isActive('heading', { level: 2 }) ? 'h2' : e.isActive('heading', { level: 3 }) ? 'h3' : 'p') as Block,
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      link: e.isActive('link'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      tasks: e.isActive('taskList'),
      quote: e.isActive('blockquote'),
      codeBlock: e.isActive('codeBlock'),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const c = () => editor.chain().focus();
  const btn = (label: string, icon: React.ReactNode, on: boolean, run: () => void, disabled = false) => (
    <button type="button" className={`tb ${on ? 'on' : ''}`} aria-label={label} title={label} aria-pressed={on} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={run}>
      {icon}
    </button>
  );
  const setLink = () => {
    const prev = (editor.getAttributes('link').href as string | undefined) ?? '';
    const url = window.prompt('Link-Adresse (leer lassen zum Entfernen)', prev || 'https://');
    if (url === null) return;
    if (!url.trim() || url.trim() === 'https://') c().extendMarkRange('link').unsetLink().run();
    else c().extendMarkRange('link').setLink({ href: url.trim() }).run();
  };
  return (
    <div className="note-toolbar" role="toolbar" aria-label="Formatierung">
      <Select
        label="Absatzart"
        size="sm"
        variant="ghost"
        value={s.block}
        options={[
          { value: 'p', label: 'Text' },
          { value: 'h1', label: 'Überschrift 1' },
          { value: 'h2', label: 'Überschrift 2' },
          { value: 'h3', label: 'Überschrift 3' },
        ]}
        onChange={(v) => (v === 'p' ? c().setParagraph().run() : c().setHeading({ level: Number(v.slice(1)) as 1 | 2 | 3 }).run())}
      />
      <span className="tb-sep" />
      {btn('Fett', <IconBold size={17} />, s.bold, () => c().toggleBold().run())}
      {btn('Kursiv', <IconItalic size={17} />, s.italic, () => c().toggleItalic().run())}
      {btn('Durchgestrichen', <IconStrike size={17} />, s.strike, () => c().toggleStrike().run())}
      {btn('Link', <IconLink size={17} />, s.link, setLink)}
      <span className="tb-sep" />
      {btn('Aufzählung', <IconListBullet size={17} />, s.bullet, () => c().toggleBulletList().run())}
      {btn('Nummerierte Liste', <IconListOrdered size={17} />, s.ordered, () => c().toggleOrderedList().run())}
      {btn('Checkliste', <IconListCheck size={17} />, s.tasks, () => c().toggleTaskList().run())}
      {btn('Zitat', <IconQuote size={17} />, s.quote, () => c().toggleBlockquote().run())}
      {btn('Code', <IconCode size={17} />, s.code || s.codeBlock, () => (editor.state.selection.empty ? c().toggleCodeBlock().run() : c().toggleCode().run()))}
      {btn('Trennlinie', <IconRule size={17} />, false, () => c().setHorizontalRule().run())}
      <span className="tb-sep" />
      <button type="button" className="tb tb-text" onMouseDown={(e) => e.preventDefault()} onClick={onInsertTask} title="Aufgabe einfügen" aria-label="Aufgabe einfügen">
        <IconTaskAdd size={17} /> <span>Aufgabe</span>
      </button>
      {s.tasks && (
        <button type="button" className="tb tb-text" onMouseDown={(e) => e.preventDefault()} onClick={onChecklistToTasks} title="Offene Punkte dieser Checkliste als echte Aufgaben anlegen" aria-label="Checkliste → Aufgaben">
          <span>Checkliste → Aufgaben</span>
        </button>
      )}
      <span className="tb-space" />
      {btn('Rückgängig', <IconUndo size={17} />, false, () => c().undo().run(), !s.canUndo)}
      {btn('Wiederholen', <IconRedo size={17} />, false, () => c().redo().run(), !s.canRedo)}
    </div>
  );
}

// ---------- Aufgabe einfügen ----------

function InsertTaskDialog({ projectId, exclude, onPick, onClose }: { projectId: string; exclude: Set<string>; onPick: (id: string) => void; onClose: () => void }) {
  const { tasks, projectMap } = useData();
  const [q, setQ] = useState('');
  const today = nowLocal().date;
  const needle = q.trim().toLowerCase();
  const found = needle
    ? tasks
        .filter((t) => !t.completedAt && !exclude.has(t.id) && t.title.toLowerCase().includes(needle))
        .sort((a, b) => Number(b.projectId === projectId) - Number(a.projectId === projectId))
        .slice(0, 8)
    : [];
  return (
    <Modal onClose={onClose} label="Aufgabe einfügen">
      <div className="insert-task">
        <strong>Neue Aufgabe</strong>
        <QuickAdd autoFocus noEvent projectId={projectId} placeholder="z. B. „Morgen Angebot schicken !1“" onCreated={onPick} />
        <strong>Oder bestehende Aufgabe verknüpfen</strong>
        <label className="insert-search">
          <IconSearch size={16} />
          <input className="input" placeholder="Aufgabe suchen …" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Bestehende Aufgabe suchen" />
        </label>
        {needle && !found.length && <p className="small muted">Keine offene Aufgabe gefunden.</p>}
        <ul className="insert-results">
          {found.map((t) => {
            const p = projectMap.get(t.projectId);
            return (
              <li key={t.id}>
                <button onClick={() => onPick(t.id)}>
                  <span className="insert-title">{t.title}</span>
                  <span className="small muted">
                    {p ? (p.isInbox ? 'Eingang' : p.name) : ''}
                    {t.dueDate ? ` · ${dueLabel(t.dueDate, t.dueTime, today)}` : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </Modal>
  );
}
