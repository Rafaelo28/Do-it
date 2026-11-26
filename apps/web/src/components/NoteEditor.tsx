import { parseTask, type ParseContext } from '@do-it/parser';
import { formatDateLong, noteTaskIds } from '@do-it/shared';
import type { JSONContent, Range } from '@tiptap/core';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from '@tiptap/markdown';
import type { Node as PMNode } from '@tiptap/pm/model';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createTaskFromParse } from '../lib/actions';
import { useData } from '../lib/data';
import type { Note } from '../lib/db';
import { countOpenChecks, looksLikeMarkdown, normalizeChecklists, wordCount } from '../lib/noteMarkdown';
import { editedLabel, updateNote } from '../lib/notes';
import { toast } from '../lib/store';
import { syncState } from '../lib/sync';
import { nowLocal } from '../lib/time';
import {
  IconBold,
  IconCalendar,
  IconCallout,
  IconCode,
  IconHeading,
  IconItalic,
  IconLink,
  IconListBullet,
  IconListCheck,
  IconListOrdered,
  IconMore,
  IconParagraph,
  IconQuote,
  IconRedo,
  IconRule,
  IconSearch,
  IconStrike,
  IconTable,
  IconTaskAdd,
  IconUndo,
  IconX,
} from './Icons';
import { MenuButton, type MenuItem } from './Menu';
import { Callout, CALLOUT_LABEL, CALLOUT_TYPES, SlashCommand, slashState, TaskRef, type SlashItem } from './notes/extensions';
import { QuickAdd } from './QuickAdd';
import { dueLabel, Modal } from './ui';

const SAVE_MS = 700;

export type SaveState = 'saved' | 'saving';

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

/** offene Checklisten-Punkte zwischen zwei Positionen */
/** Checklisten (oberste Ebene), die den Bereich berühren */
function checklistsIn(doc: PMNode, from: number, to: number): number[] {
  const lists: number[] = [];
  doc.nodesBetween(Math.max(0, from), Math.min(doc.content.size, to), (node, pos) => {
    if (node.type.name === 'taskList') {
      lists.push(pos);
      return false;
    }
    return true;
  });
  return lists;
}

/** offene, nicht leere Punkte dieser Checklisten (genau die, die "Als Aufgaben anlegen" umwandelt) */
function openChecksIn(doc: PMNode, from: number, to: number): number {
  let n = 0;
  for (const pos of checklistsIn(doc, from, to)) {
    doc.nodeAt(pos)?.forEach((item) => {
      if (!item.attrs.checked && item.firstChild?.textContent.trim()) n++;
    });
  }
  return n;
}

/** Bereich der obersten Blöcke um from…to (eingefügter Inhalt ersetzt oft den leeren Absatz davor) */
function blockRange(doc: PMNode, from: number, to: number): { from: number; to: number } {
  const a = doc.resolve(Math.max(0, Math.min(from, doc.content.size)));
  const b = doc.resolve(Math.max(0, Math.min(to, doc.content.size)));
  return { from: a.depth ? a.before(1) : from, to: b.depth ? b.after(1) : to };
}

interface PasteOffer {
  from: number;
  to: number;
  count: number;
}

export function NoteEditor({ note, focusTitle, showOutline, onSaveState }: { note: Note; focusTitle?: boolean; showOutline?: boolean; onSaveState?: (s: SaveState) => void }) {
  const [title, setTitle] = useState(note.title);
  const [inserting, setInserting] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [offer, setOffer] = useState<PasteOffer | null>(null);
  const offerRef = useRef<PasteOffer | null>(null);
  offerRef.current = offer;
  /** zuletzt gespeicherter oder geladener Text – zum Erkennen von Änderungen anderer Geräte */
  const saved = useRef({ title: note.title, body: note.body });
  const timer = useRef<{ body?: number; title?: number }>({});
  const editorRef = useRef<Editor | null>(null);
  const me = syncState.select((s) => s.me);
  const ctx = useParseContext();
  const now = useMemo(() => nowLocal(), []);
  const statusCb = useRef(onSaveState);
  statusCb.current = onSaveState;

  const flushBody = () => {
    if (timer.current.body) clearTimeout(timer.current.body);
    timer.current.body = undefined;
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed) return;
    const body = ed.getMarkdown();
    if (body !== saved.current.body) {
      saved.current.body = body;
      void updateNote(note.id, { body });
    }
    if (!timer.current.title) statusCb.current?.('saved');
  };
  const flushTitle = (value = title) => {
    if (timer.current.title) clearTimeout(timer.current.title);
    timer.current.title = undefined;
    if (value !== saved.current.title) {
      saved.current.title = value;
      void updateNote(note.id, { title: value });
    }
    if (!timer.current.body) statusCb.current?.('saved');
  };

  // Einträge für das "/"-Menü
  const slashItems = useRef<() => SlashItem[]>(() => []);
  slashItems.current = () => {
    const run = (fn: (c: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => (editor: Editor, range: Range) => void fn(editor.chain().focus().deleteRange(range)).run();
    return [
      { id: 'p', label: 'Text', keywords: 'absatz normal paragraph', icon: <IconParagraph size={16} />, run: run((c) => c.setParagraph()) },
      { id: 'h1', label: 'Überschrift 1', keywords: 'titel h1 heading', icon: <IconHeading size={16} />, run: run((c) => c.setHeading({ level: 1 })) },
      { id: 'h2', label: 'Überschrift 2', keywords: 'h2 heading', icon: <IconHeading size={15} />, run: run((c) => c.setHeading({ level: 2 })) },
      { id: 'h3', label: 'Überschrift 3', keywords: 'h3 heading', icon: <IconHeading size={14} />, run: run((c) => c.setHeading({ level: 3 })) },
      { id: 'check', label: 'Checkliste', hint: '[ ]', keywords: 'todo haken liste task', icon: <IconListCheck size={16} />, run: run((c) => c.toggleTaskList()) },
      { id: 'ul', label: 'Aufzählung', hint: '-', keywords: 'liste punkte bullet', icon: <IconListBullet size={16} />, run: run((c) => c.toggleBulletList()) },
      { id: 'ol', label: 'Nummerierte Liste', hint: '1.', keywords: 'liste zahlen ordered', icon: <IconListOrdered size={16} />, run: run((c) => c.toggleOrderedList()) },
      {
        id: 'task',
        label: 'Aufgabe einfügen',
        keywords: 'todo aufgabe task verknüpfen',
        icon: <IconTaskAdd size={16} />,
        run: (editor, range) => {
          editor.chain().focus().deleteRange(range).run();
          setInserting(true);
        },
      },
      { id: 'quote', label: 'Zitat', hint: '>', keywords: 'quote zitat', icon: <IconQuote size={16} />, run: run((c) => c.toggleBlockquote()) },
      ...CALLOUT_TYPES.map((t) => ({
        id: `callout-${t}`,
        label: `Hinweis: ${CALLOUT_LABEL[t]}`,
        keywords: `callout box hinweis ${t} ${CALLOUT_LABEL[t].toLowerCase()}`,
        icon: <IconCallout size={16} />,
        run: run((c) => c.toggleCallout(t)),
      })),
      { id: 'table', label: 'Tabelle', keywords: 'table tabelle', icon: <IconTable size={16} />, run: run((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true })) },
      { id: 'code', label: 'Codeblock', hint: '```', keywords: 'code programm', icon: <IconCode size={16} />, run: run((c) => c.toggleCodeBlock()) },
      { id: 'hr', label: 'Trennlinie', hint: '---', keywords: 'linie trenner divider', icon: <IconRule size={16} />, run: run((c) => c.setHorizontalRule()) },
      { id: 'date', label: 'Datum von heute', keywords: 'datum heute date', icon: <IconCalendar size={16} />, run: run((c) => c.insertContent(`${formatDateLong(nowLocal().date)} `)) },
    ];
  };

  /** Nach dem Einfügen: kamen offene Checklisten-Punkte dazu? Dann Umwandeln anbieten (nicht automatisch). */
  const offerFor = (from: number, to: number) => {
    const ed = editorRef.current;
    if (!ed) return;
    const range = blockRange(ed.state.doc, from, to);
    const count = openChecksIn(ed.state.doc, range.from, range.to);
    if (count) setOffer({ ...range, count });
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        underline: false,
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
      }),
      TaskList,
      TaskItem.configure({ nested: true, a11y: { checkboxLabel: (node) => `Punkt abhaken: ${node.textContent || 'leer'}` } }),
      TableKit.configure({ table: { resizable: false } }),
      Callout,
      TaskRef.configure({ projectId: note.projectId }),
      Placeholder.configure({
        placeholder: ({ node }) => (node.type.name === 'heading' ? 'Überschrift' : 'Schreib los … „/“ für Überschriften, Checklisten, Tabellen und mehr'),
      }),
      SlashCommand.configure({ items: () => slashItems.current() }),
      Markdown,
    ],
    content: note.body,
    contentType: 'markdown',
    autofocus: focusTitle ? false : 'end',
    editorProps: {
      attributes: { class: 'note-prose', 'aria-label': 'Notiz', spellcheck: 'true' },
      handleClick: (_view, _pos, event) => {
        const a = (event.target as HTMLElement).closest('a');
        if (a && (event.metaKey || event.ctrlKey)) {
          // nur normale Web-, Mail- und Telefon-Links öffnen (Notizen können von anderen kommen)
          if (/^(https?:|mailto:|tel:)/i.test(a.href)) window.open(a.href, '_blank', 'noopener,noreferrer');
          return true;
        }
        return false;
      },
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
          event.preventDefault();
          setLinkOpen(true);
          return true;
        }
        return false;
      },
      handlePaste: (view, event) => {
        const ed = editorRef.current;
        if (!ed) return false;
        const text = event.clipboardData?.getData('text/plain') ?? '';
        const html = event.clipboardData?.getData('text/html') ?? '';
        const before = view.state.selection.from;
        // Aus einem Editor/einer Webseite mit echter Struktur: so übernehmen, wie es kommt
        const structured = html.includes('data-pm-slice') || /<(ul|ol|li|h[1-6]|table|blockquote|pre)\b/i.test(html);
        if (!text || structured || !looksLikeMarkdown(text)) {
          // nur nachfragen, wenn wirklich eine Checkliste mitkam (z. B. aus Nextcloud oder einer anderen Notiz)
          if (/type=["']?checkbox|data-type=["']?taskList|data-checked/i.test(html)) window.setTimeout(() => offerFor(before, view.state.selection.to), 0);
          return false;
        }
        // Text mit Markdown oder Checklisten ("[] Milch"): als Markdown einfügen
        event.preventDefault();
        const md = normalizeChecklists(text);
        ed.chain().focus().insertContent(md, { contentType: 'markdown' }).run();
        if (countOpenChecks(md)) offerFor(before, ed.state.selection.to);
        return true;
      },
    },
    onUpdate: () => {
      if (timer.current.body) clearTimeout(timer.current.body);
      timer.current.body = window.setTimeout(flushBody, SAVE_MS);
      statusCb.current?.('saving');
    },
    onTransaction: ({ transaction }) => {
      // Hinweis nach dem Einfügen: Bereich mitführen, wenn weitergeschrieben wird
      const o = offerRef.current;
      if (o && transaction.docChanged) {
        const from = transaction.mapping.map(o.from, -1);
        const to = transaction.mapping.map(o.to, 1);
        if (from !== o.from || to !== o.to) setOffer({ ...o, from, to });
      }
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

  const titleRef = useRef(title);
  titleRef.current = title;
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

  function insertTask(id: string) {
    const ed = editorRef.current;
    if (!ed) return;
    const atEnd = ed.state.selection.$from.after(1) >= ed.state.doc.content.size - 1;
    // nur am Ende einen leeren Absatz anhängen, damit man weiterschreiben kann
    ed.chain()
      .focus()
      .insertContent(atEnd ? [{ type: 'taskRef', attrs: { id } }, { type: 'paragraph' }] : [{ type: 'taskRef', attrs: { id } }])
      .run();
  }

  /** Offene Punkte aller Checklisten im Bereich werden echte Aufgaben (Datum, #Projekt usw. werden erkannt) */
  async function convertChecklists(from: number, to: number) {
    const ed = editorRef.current;
    if (!ed || !me) return;
    const lists = checklistsIn(ed.state.doc, from, to);
    let created = 0;
    // von hinten, damit die Positionen davor gültig bleiben
    for (const pos of lists.reverse()) {
      const list = ed.state.doc.nodeAt(pos);
      if (!list || list.type.name !== 'taskList') continue;
      // Reihenfolge bleibt: offene Punkte werden Aufgaben, erledigte bleiben als Checkliste, Unterpunkte bleiben erhalten
      const parts: ({ open: string; nested: JSONContent[] } | { done: JSONContent })[] = [];
      list.forEach((item) => {
        const text = item.firstChild?.textContent.trim() ?? '';
        if (item.attrs.checked || !text) {
          if (text || item.childCount > 1) parts.push({ done: item.toJSON() as JSONContent });
          return;
        }
        const nested: JSONContent[] = [];
        item.forEach((child, _o, i) => {
          if (i > 0) nested.push(child.toJSON() as JSONContent);
        });
        parts.push({ open: text, nested });
      });
      if (!parts.some((p) => 'open' in p)) continue;
      const content: JSONContent[] = [];
      let done: JSONContent[] = [];
      const flush = () => {
        if (done.length) content.push({ type: 'taskList', content: done });
        done = [];
      };
      for (const p of parts) {
        if ('done' in p) {
          done.push(p.done);
          continue;
        }
        flush();
        const r = parseTask(p.open, ctx);
        if (r.title.trim()) {
          content.push({ type: 'taskRef', attrs: { id: await createTaskFromParse(r, { projectId: note.projectId, me }) } });
          created++;
        } else content.push({ type: 'paragraph', content: [{ type: 'text', text: p.open }] });
        content.push(...p.nested);
      }
      flush();
      const current = ed.state.doc.nodeAt(pos);
      if (!current || current.type.name !== 'taskList') continue;
      ed.chain().focus().insertContentAt({ from: pos, to: pos + current.nodeSize }, content).run();
    }
    setOffer(null);
    toast(created ? `${created} ${created === 1 ? 'Aufgabe' : 'Aufgaben'} angelegt` : 'Keine offenen Punkte gefunden');
  }

  /** Checkliste, in der der Cursor steht */
  function checklistAtCursor(): { from: number; to: number } | null {
    const ed = editorRef.current;
    if (!ed) return null;
    const { $from } = ed.state.selection;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === 'taskList') {
        const pos = $from.before(d);
        return { from: pos, to: pos + $from.node(d).nodeSize };
      }
    }
    return null;
  }

  const info = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e) return { words: 0, tasks: 0, headings: [] as { level: number; text: string; pos: number }[] };
      const headings: { level: number; text: string; pos: number }[] = [];
      e.state.doc.descendants((n, pos) => {
        if (n.type.name === 'heading' && n.textContent.trim()) headings.push({ level: n.attrs.level as number, text: n.textContent.trim(), pos });
        return n.type.name !== 'heading';
      });
      return { words: wordCount(e.state.doc.textContent), tasks: noteTaskIds(e.getMarkdown()).length, headings };
    },
  });

  return (
    <div className={`note-editor ${showOutline ? 'with-outline' : ''}`}>
      {editor && (
        <Toolbar
          editor={editor}
          onInsertTask={() => setInserting(true)}
          onLink={() => setLinkOpen(true)}
          onChecklistToTasks={() => {
            const r = checklistAtCursor();
            if (r) void convertChecklists(r.from, r.to);
          }}
        />
      )}
      <div className="note-doc-wrap">
        <article className="note-doc">
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
              statusCb.current?.('saving');
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
          <div className="note-meta small muted">
            {info?.words ?? 0} {info?.words === 1 ? 'Wort' : 'Wörter'}
            {info?.tasks ? ` · ${info.tasks} ${info.tasks === 1 ? 'Aufgabe' : 'Aufgaben'}` : ''} · bearbeitet {editedLabel(note.updatedAt, now.date)}
          </div>
          {offer && (
            <div className="note-offer" role="status">
              <IconListCheck size={18} />
              <span className="note-offer-text">
                {offer.count} {offer.count === 1 ? 'offener Punkt' : 'offene Punkte'} als Checkliste eingefügt. Sollen daraus echte Aufgaben werden?
              </span>
              <span className="note-offer-actions">
              <button className="btn small primary" onClick={() => void convertChecklists(offer.from, offer.to)}>
                Als Aufgaben anlegen
              </button>
              <button
                className="btn small ghost"
                onClick={() => {
                  setOffer(null);
                  editor?.commands.focus();
                }}
              >
                Checkliste behalten
              </button>
              </span>
            </div>
          )}
          <EditorContent editor={editor} className="note-body" />
        </article>
        {showOutline && editor && <Outline editor={editor} headings={info?.headings ?? []} />}
      </div>
      <SlashMenu />
      {inserting && (
        <InsertTaskDialog
          projectId={note.projectId}
          exclude={new Set(noteTaskIds(editor?.getMarkdown() ?? ''))}
          onPick={(id) => {
            setInserting(false);
            insertTask(id);
          }}
          onClose={() => setInserting(false)}
        />
      )}
      {linkOpen && editor && <LinkDialog editor={editor} onClose={() => setLinkOpen(false)} />}
    </div>
  );
}

// ---------- Werkzeugleiste (eine Zeile, Rest im "…"-Menü) ----------

type Block = 'p' | 'h1' | 'h2' | 'h3';

interface ToolItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  /** 1 = immer sichtbar, 4 = nur auf breiten Bildschirmen */
  prio: number;
  on?: boolean;
  disabled?: boolean;
  run: () => void;
  /** Trennlinie davor */
  group?: boolean;
}

const BLOCK_LABEL: Record<Block, string> = { p: 'Text', h1: 'Überschrift 1', h2: 'Überschrift 2', h3: 'Überschrift 3' };

function Toolbar({ editor, onInsertTask, onLink, onChecklistToTasks }: { editor: Editor; onInsertTask: () => void; onLink: () => void; onChecklistToTasks: () => void }) {
  const bar = useRef<HTMLDivElement>(null);
  const [level, setLevel] = useState(4);
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const w = e!.contentRect.width;
      setLevel(w >= 760 ? 4 : w >= 600 ? 3 : w >= 430 ? 2 : 1);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
      table: e.isActive('table'),
      callout: e.isActive('callout') ? ((e.getAttributes('callout').type as string) ?? 'info') : null,
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const c = () => editor.chain().focus();
  const items: ToolItem[] = [
    { id: 'bold', label: 'Fett (Strg+B)', icon: <IconBold size={17} />, prio: 1, on: s.bold, run: () => c().toggleBold().run(), group: true },
    { id: 'italic', label: 'Kursiv (Strg+I)', icon: <IconItalic size={17} />, prio: 2, on: s.italic, run: () => c().toggleItalic().run() },
    { id: 'strike', label: 'Durchgestrichen', icon: <IconStrike size={17} />, prio: 3, on: s.strike, run: () => c().toggleStrike().run() },
    { id: 'link', label: 'Link (Strg+K)', icon: <IconLink size={17} />, prio: 2, on: s.link, run: onLink },
    { id: 'check', label: 'Checkliste', icon: <IconListCheck size={17} />, prio: 1, on: s.tasks, run: () => c().toggleTaskList().run(), group: true },
    { id: 'bullet', label: 'Aufzählung', icon: <IconListBullet size={17} />, prio: 1, on: s.bullet, run: () => c().toggleBulletList().run() },
    { id: 'ordered', label: 'Nummerierte Liste', icon: <IconListOrdered size={17} />, prio: 2, on: s.ordered, run: () => c().toggleOrderedList().run() },
    { id: 'quote', label: 'Zitat', icon: <IconQuote size={17} />, prio: 3, on: s.quote, run: () => c().toggleBlockquote().run(), group: true },
    { id: 'callout', label: 'Hinweis-Box', icon: <IconCallout size={17} />, prio: 3, on: !!s.callout, run: () => c().toggleCallout((s.callout as never) ?? 'info').run() },
    { id: 'table', label: 'Tabelle', icon: <IconTable size={17} />, prio: 3, on: s.table, disabled: s.table, run: () => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    {
      id: 'code',
      label: 'Code',
      icon: <IconCode size={17} />,
      prio: 4,
      on: s.code || s.codeBlock,
      run: () => (editor.state.selection.empty ? c().toggleCodeBlock().run() : c().toggleCode().run()),
    },
    { id: 'hr', label: 'Trennlinie', icon: <IconRule size={17} />, prio: 4, run: () => c().setHorizontalRule().run() },
    { id: 'undo', label: 'Rückgängig (Strg+Z)', icon: <IconUndo size={17} />, prio: 4, disabled: !s.canUndo, run: () => c().undo().run(), group: true },
    { id: 'redo', label: 'Wiederholen', icon: <IconRedo size={17} />, prio: 4, disabled: !s.canRedo, run: () => c().redo().run() },
  ];
  const visible = items.filter((i) => i.prio <= level);
  const hidden = items.filter((i) => i.prio > level);
  const blockMenu: MenuItem[] = (['p', 'h1', 'h2', 'h3'] as Block[]).map((b) => ({
    label: BLOCK_LABEL[b],
    icon: b === 'p' ? <IconParagraph size={16} /> : <IconHeading size={b === 'h1' ? 17 : b === 'h2' ? 15 : 13} />,
    on: s.block === b,
    onSelect: () => (b === 'p' ? c().setParagraph().run() : c().setHeading({ level: Number(b.slice(1)) as 1 | 2 | 3 }).run()),
  }));

  return (
    <div className="note-toolbar-wrap">
      <div className="note-toolbar" ref={bar} role="toolbar" aria-label="Formatierung">
        <MenuButton label={`Absatzart: ${BLOCK_LABEL[s.block]}`} icon={s.block === 'p' ? <IconParagraph size={17} /> : <IconHeading size={17} />} text={BLOCK_LABEL[s.block]} className="tb tb-block" items={blockMenu} />
        {visible.map((i) => (
          <span key={i.id} className="tb-item">
            {i.group && <span className="tb-sep" aria-hidden="true" />}
            <button type="button" className={`tb ${i.on ? 'on' : ''}`} aria-label={i.label} title={i.label} aria-pressed={i.on} disabled={i.disabled} onMouseDown={(e) => e.preventDefault()} onClick={i.run}>
              {i.icon}
            </button>
          </span>
        ))}
        <span className="tb-sep" aria-hidden="true" />
        <button type="button" className="tb tb-text" onMouseDown={(e) => e.preventDefault()} onClick={onInsertTask} title="Aufgabe einfügen" aria-label="Aufgabe einfügen">
          <IconTaskAdd size={17} /> {level >= 2 && <span>Aufgabe</span>}
        </button>
        {hidden.length > 0 && (
          <MenuButton
            label="Weitere Formate"
            icon={<IconMore size={18} />}
            className="tb"
            items={hidden.map((i, n) => ({ label: i.label.replace(/ \(.*\)$/, ''), icon: i.icon, on: i.on, disabled: i.disabled, onSelect: i.run, separator: n > 0 && i.group }))}
          />
        )}
      </div>
      {(s.tasks || s.table || s.callout) && (
        <div className="note-context" role="toolbar" aria-label="Weitere Werkzeuge">
          {s.tasks && (
            <button type="button" className="chip ctx" onMouseDown={(e) => e.preventDefault()} onClick={onChecklistToTasks} title="Offene Punkte dieser Checkliste als echte Aufgaben anlegen" aria-label="Checkliste → Aufgaben">
              <IconTaskAdd size={14} /> Offene Punkte als Aufgaben anlegen
            </button>
          )}
          {s.table && (
            <>
              <span className="small muted">Tabelle:</span>
              <button type="button" className="chip ctx" onMouseDown={(e) => e.preventDefault()} onClick={() => c().addRowAfter().run()}>
                + Zeile
              </button>
              <button type="button" className="chip ctx" onMouseDown={(e) => e.preventDefault()} onClick={() => c().addColumnAfter().run()}>
                + Spalte
              </button>
              <button type="button" className="chip ctx" onMouseDown={(e) => e.preventDefault()} onClick={() => c().deleteRow().run()}>
                Zeile löschen
              </button>
              <button type="button" className="chip ctx" onMouseDown={(e) => e.preventDefault()} onClick={() => c().deleteColumn().run()}>
                Spalte löschen
              </button>
              <button type="button" className="chip ctx danger" onMouseDown={(e) => e.preventDefault()} onClick={() => c().deleteTable().run()}>
                Tabelle löschen
              </button>
            </>
          )}
          {s.callout && (
            <>
              <span className="small muted">Hinweis:</span>
              {CALLOUT_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`chip ctx callout-chip callout-chip-${t} ${s.callout === t ? 'on' : ''}`}
                  aria-pressed={s.callout === t}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => c().updateAttributes('callout', { type: t }).run()}
                >
                  {CALLOUT_LABEL[t]}
                </button>
              ))}
              <button type="button" className="chip ctx" onMouseDown={(e) => e.preventDefault()} onClick={() => c().lift('callout').run()}>
                Box entfernen
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- "/"-Menü ----------

function SlashMenu() {
  const s = slashState.use();
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('.slash-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [s.index]);
  if (!s.open || !s.rect || !s.items.length) return null;
  const below = window.innerHeight - s.rect.bottom > 300;
  const style: React.CSSProperties = {
    left: Math.max(8, Math.min(s.rect.left, window.innerWidth - 268)),
    ...(below ? { top: s.rect.bottom + 6 } : { bottom: window.innerHeight - s.rect.top + 6 }),
  };
  return createPortal(
    <div className="slash-menu" role="listbox" aria-label="Block einfügen" style={style} ref={list}>
      {s.items.map((it, i) => (
        <button
          key={it.id}
          type="button"
          role="option"
          aria-selected={i === s.index}
          className={`slash-item ${i === s.index ? 'active' : ''}`}
          onMouseDown={(e) => e.preventDefault()}
          onPointerEnter={() => slashState.set({ ...slashState.get(), index: i })}
          onClick={() => s.pick?.(it)}
        >
          <span className="slash-icon">{it.icon}</span>
          <span className="slash-label">{it.label}</span>
          {it.hint && <span className="slash-hint">{it.hint}</span>}
        </button>
      ))}
    </div>,
    document.body,
  );
}

// ---------- Gliederung ----------

function Outline({ editor, headings }: { editor: Editor; headings: { level: number; text: string; pos: number }[] }) {
  return (
    <nav className="note-outline" aria-label="Gliederung">
      <div className="small muted note-outline-title">Gliederung</div>
      {!headings.length && <p className="small muted">Noch keine Überschriften. Mit „# “ oder „/“ legst du eine an.</p>}
      {headings.map((h) => (
        <button
          key={h.pos}
          className={`note-outline-item lvl${h.level}`}
          onClick={() => {
            editor.chain().focus().setTextSelection(h.pos + 1).run();
            (editor.view.nodeDOM(h.pos) as HTMLElement | null)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }}
        >
          {h.text}
        </button>
      ))}
    </nav>
  );
}

// ---------- Link ----------

function LinkDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const prev = (editor.getAttributes('link').href as string | undefined) ?? '';
  const hasText = !editor.state.selection.empty || editor.isActive('link');
  const [url, setUrl] = useState(prev);
  const [text, setText] = useState('');
  const apply = () => {
    const raw = url.trim();
    const href = raw && !/^[a-z][\w+.-]*:/i.test(raw) ? `https://${raw}` : raw;
    if (href && !/^(https?:|mailto:|tel:)/i.test(href)) return toast('Nur Web-, Mail- und Telefon-Links', { kind: 'error' });
    const c = editor.chain().focus().extendMarkRange('link');
    if (!href) c.unsetLink().run();
    else if (hasText) c.setLink({ href }).run();
    else c.insertContent({ type: 'text', text: text.trim() || href, marks: [{ type: 'link', attrs: { href } }] }).insertContent(' ').run();
    onClose();
  };
  return (
    <Modal onClose={onClose} label="Link">
      <form
        className="link-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <strong>{prev ? 'Link bearbeiten' : 'Link einfügen'}</strong>
        <label className="field">
          <span>Adresse</span>
          <input className="input" autoFocus value={url} placeholder="https://…" inputMode="url" onChange={(e) => setUrl(e.target.value)} />
        </label>
        {!hasText && (
          <label className="field">
            <span>Text (optional)</span>
            <input className="input" value={text} onChange={(e) => setText(e.target.value)} />
          </label>
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          {prev && (
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                editor.chain().focus().extendMarkRange('link').unsetLink().run();
                onClose();
              }}
            >
              Link entfernen
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button type="submit" className="btn primary">
            Übernehmen
          </button>
        </div>
      </form>
    </Modal>
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
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <strong>Neue Aufgabe</strong>
          <button className="icon-btn" aria-label="Schließen" onClick={onClose}>
            <IconX size={16} />
          </button>
        </div>
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
