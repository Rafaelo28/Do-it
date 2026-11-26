import { Extension, Node, mergeAttributes, type Editor, type JSONContent, type MarkdownToken, type Range } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import { useLocation } from 'wouter';
import { toggleTask } from '../../lib/actions';
import { useData } from '../../lib/data';
import { createStore } from '../../lib/store';
import { syncState } from '../../lib/sync';
import { nowLocal } from '../../lib/time';
import { IconX } from '../Icons';
import { dueLabel, PRIORITY_COLOR } from '../ui';

// ---------- Eingebettete Aufgabe ----------

/** Eigene Zeile "[[task:<id>]]" im Markdown – im Editor eine echte, abhakbare Aufgabe */
export const TaskRef = Node.create<{ projectId?: string }>({
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

// ---------- Hinweis-Box (wie Nextcloud Text: "::: info" … ":::") ----------

export const CALLOUT_TYPES = ['info', 'success', 'warn', 'error'] as const;
export type CalloutType = (typeof CALLOUT_TYPES)[number];
export const CALLOUT_LABEL: Record<CalloutType, string> = { info: 'Info', success: 'Erfolg', warn: 'Warnung', error: 'Fehler' };

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      /** Absatz in eine Hinweis-Box packen bzw. Art wechseln / Box auflösen */
      toggleCallout: (type: CalloutType) => ReturnType;
    };
  }
}

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      type: {
        default: 'info',
        parseHTML: (el) => (CALLOUT_TYPES as readonly string[]).includes(el.getAttribute('data-callout') ?? '') ? el.getAttribute('data-callout') : 'info',
        renderHTML: (a) => ({ 'data-callout': a.type as string }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-callout]' }];
  },
  renderHTML({ HTMLAttributes, node }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: `callout callout-${String(node.attrs.type)}` }), 0];
  },
  addCommands() {
    return {
      toggleCallout:
        (type) =>
        ({ editor, commands }) => {
          if (editor.isActive('callout', { type })) return commands.lift('callout');
          if (editor.isActive('callout')) return commands.updateAttributes('callout', { type });
          return commands.wrapIn('callout', { type });
        },
    };
  },
  markdownTokenizer: {
    name: 'callout',
    level: 'block',
    start: (src: string) => {
      const m = /(^|\n):::[ \t]*(?:info|success|warn|error)\b/.exec(src);
      return m ? m.index + m[1]!.length : -1;
    },
    tokenize: (src, _tokens, lexer) => {
      const m = /^:::[ \t]*(info|success|warn|error)[ \t]*\n([\s\S]*?)\n:::[ \t]*(?:\n|$)/.exec(src);
      if (!m) return undefined;
      return { type: 'callout', raw: m[0], calloutType: m[1], tokens: lexer.blockTokens(m[2]!) } as MarkdownToken;
    },
  },
  parseMarkdown: (token, h) => {
    const t = token as MarkdownToken & { calloutType: string; tokens?: MarkdownToken[] };
    const children = h.parseChildren(t.tokens ?? []);
    return h.createNode('callout', { type: t.calloutType }, children.length ? children : [{ type: 'paragraph' }]);
  },
  renderMarkdown: (node: JSONContent, h) => `::: ${String(node.attrs?.type ?? 'info')}\n${h.renderChildren(node.content ?? [], '\n\n')}\n:::`,
});

// ---------- Schrägstrich-Menü ----------

export interface SlashItem {
  id: string;
  label: string;
  hint?: string;
  keywords: string;
  icon: React.ReactNode;
  run: (editor: Editor, range: Range) => void;
}

export interface SlashState {
  open: boolean;
  items: SlashItem[];
  index: number;
  rect: { left: number; top: number; bottom: number } | null;
  pick: ((item: SlashItem) => void) | null;
}

/** Zustand des Menüs (die Liste rendert NoteEditor) */
export const slashState = createStore<SlashState>({ open: false, items: [], index: 0, rect: null, pick: null });

export function filterSlashItems(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((i) => i.label.toLowerCase().includes(q) || i.keywords.includes(q));
}

/** "/" am Zeilenanfang oder nach einem Leerzeichen öffnet das Menü für Blöcke (Überschrift, Liste, Tabelle …) */
export const SlashCommand = Extension.create<{ items: () => SlashItem[] }>({
  name: 'slashCommand',
  addOptions() {
    return { items: () => [] };
  },
  addProseMirrorPlugins() {
    const getItems = this.options.items;
    const show = (p: SuggestionProps<SlashItem, SlashItem>) => {
      const r = p.clientRect?.();
      slashState.set((s) => ({
        open: p.items.length > 0,
        items: p.items,
        index: Math.min(s.open ? s.index : 0, Math.max(0, p.items.length - 1)),
        rect: r ? { left: r.left, top: r.top, bottom: r.bottom } : s.rect,
        pick: (item) => p.command(item),
      }));
    };
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        char: '/',
        allowSpaces: false,
        startOfLine: false,
        allowedPrefixes: [' '],
        items: ({ query }) => filterSlashItems(getItems(), query).slice(0, 14),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => ({
          onStart: show,
          onUpdate: show,
          onKeyDown: ({ event }: SuggestionKeyDownProps) => {
            const s = slashState.get();
            if (!s.open || !s.items.length) return false;
            if (event.key === 'ArrowDown') {
              slashState.set({ ...s, index: (s.index + 1) % s.items.length });
              return true;
            }
            if (event.key === 'ArrowUp') {
              slashState.set({ ...s, index: (s.index - 1 + s.items.length) % s.items.length });
              return true;
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              const item = s.items[s.index];
              if (item && s.pick) s.pick(item);
              return true;
            }
            if (event.key === 'Escape') {
              slashState.set({ ...s, open: false });
              return true;
            }
            return false;
          },
          onExit: () => slashState.set({ open: false, items: [], index: 0, rect: null, pick: null }),
        }),
      }),
    ];
  },
});
