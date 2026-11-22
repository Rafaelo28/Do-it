/** Eingebettete Aufgabe in einer Notiz: eigene Zeile "[[task:<uuid>]]" */
export const TASK_REF_LINE = /^[ \t]*\[\[task:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\][ \t]*$/gim;

export function taskRef(id: string): string {
  return `[[task:${id}]]`;
}

/** IDs aller eingebetteten Aufgaben, in Reihenfolge, ohne Doppelte */
export function noteTaskIds(body: string): string[] {
  const ids: string[] = [];
  for (const m of body.matchAll(TASK_REF_LINE)) if (!ids.includes(m[1]!.toLowerCase())) ids.push(m[1]!.toLowerCase());
  return ids;
}

/** Markdown grob zu Klartext (Vorschau in Listen, Suche) */
export function markdownToText(body: string): string {
  return body
    .replace(TASK_REF_LINE, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]\s+\[[ xX]\]|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\s)[*_](\S[^*_]*)[*_](?=\s|$)/g, '$1$2')
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Titel einer Notiz: eigener Titel, sonst die erste Zeile */
export function noteTitle(n: { title: string; body: string }): string {
  if (n.title.trim()) return n.title.trim();
  const first = markdownToText(n.body.split('\n').find((l) => markdownToText(l)) ?? '');
  return first ? (first.length > 60 ? `${first.slice(0, 60)}…` : first) : 'Unbenannte Notiz';
}
