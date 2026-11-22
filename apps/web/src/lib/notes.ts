import { formatDateRelative, TASK_REF_LINE, uuidv7, type NoteData } from '@do-it/shared';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Note, type Task } from './db';
import { sync } from './sync';

/** Alle Notizen (eigene Abfrage, damit Tippen in einer Notiz nicht die ganze App neu zeichnet) */
export function useNotes(): Note[] | undefined {
  return useLiveQuery(() => db.notes.toArray(), []);
}

export function useNote(id: string | undefined): Note | null | undefined {
  return useLiveQuery(async () => (id ? ((await db.notes.get(id)) ?? null) : null), [id]);
}

export async function createNote(projectId: string, init?: Partial<NoteData>): Promise<string> {
  const id = uuidv7();
  const now = new Date().toISOString();
  await sync.mutate('note', id, 'put', { projectId, title: '', body: '', pinned: false, archived: false, createdAt: now, updatedAt: now, ...init });
  return id;
}

export async function updateNote(id: string, changes: Partial<NoteData>): Promise<void> {
  await sync.mutate('note', id, 'put', { ...changes, updatedAt: new Date().toISOString() });
}

export async function deleteNote(id: string): Promise<void> {
  await sync.mutate('note', id, 'delete');
}

/** Pinned zuerst, dann zuletzt bearbeitet */
export function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => Number(b.pinned) - Number(a.pinned) || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/** "gerade eben", "vor 5 Min.", "14:32", "gestern", "Mo., 23. Nov." */
export function editedLabel(iso: string, today: string): string {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'gerade eben';
  if (mins < 60) return `vor ${mins} Min.`;
  const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (local === today) return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return formatDateRelative(local, today);
}

/** Markdown zum Herunterladen: eingebettete Aufgaben als normale Checklisten-Zeilen */
export function exportMarkdown(n: Note, tasks: Map<string, Task>): string {
  const body = n.body.replace(TASK_REF_LINE, (_line, id: string) => {
    const t = tasks.get(id.toLowerCase());
    if (!t) return '- [ ] (gelöschte Aufgabe)';
    const due = t.dueDate ? ` (${t.dueDate}${t.dueTime ? ` ${t.dueTime}` : ''})` : '';
    return `- [${t.completedAt ? 'x' : ' '}] ${t.title}${due}`;
  });
  return n.title.trim() ? `# ${n.title.trim()}\n\n${body}` : body;
}
