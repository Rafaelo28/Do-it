/** Hilfen rund um Notizen: Einfügen von Text, Gruppierung der Liste. Ohne Abhängigkeit vom Editor (testbar). */

const CHECK_OPEN = /^(\s*)(?:[-*+]\s+)?(?:\[\s?\]|☐|□|▢|○)\s*(?=\S)/;
const CHECK_DONE = /^(\s*)(?:[-*+]\s+)?(?:\[[xX✓✔]\]|☑|☒|✅|✓|✔)\s*(?=\S)/;

/**
 * Checklisten-Schreibweisen aus anderen Apps vereinheitlichen:
 * "[] Milch", "[ ] Milch", "- [] Milch", "☐ Milch" → "- [ ] Milch"; "[x] Butter", "☑ Butter" → "- [x] Butter".
 */
export function normalizeChecklists(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      if (CHECK_DONE.test(line)) return line.replace(CHECK_DONE, '$1- [x] ');
      if (CHECK_OPEN.test(line)) return line.replace(CHECK_OPEN, '$1- [ ] ');
      return line;
    })
    .join('\n');
}

/** Sieht der eingefügte Text nach Markdown oder einer Checkliste aus? (Sonst normal einfügen) */
export function looksLikeMarkdown(text: string): boolean {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.some((l) => CHECK_OPEN.test(l) || CHECK_DONE.test(l))) return true;
  const block = lines.filter((l) => /^\s{0,3}(?:#{1,6}\s+\S|[-*+]\s+\S|\d+[.)]\s+\S|>\s?\S|```|:::|\|.+\|\s*$|-{3,}\s*$)/.test(l)).length;
  if (block >= 1 && lines.length > 1) return true;
  return /\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|`[^`\n]+`/.test(text);
}

/** Zählt offene Checklisten-Punkte in Markdown (für den Hinweis nach dem Einfügen) */
export function countOpenChecks(markdown: string): number {
  return markdown.split('\n').filter((l) => /^\s*[-*+]\s+\[ \]\s+\S/.test(l)).length;
}

export type NoteGroup = 'pinned' | 'today' | 'yesterday' | 'week' | 'month' | 'older';

export const NOTE_GROUP_LABEL: Record<NoteGroup, string> = {
  pinned: 'Angeheftet',
  today: 'Heute',
  yesterday: 'Gestern',
  week: 'Letzte 7 Tage',
  month: 'Letzte 30 Tage',
  older: 'Älter',
};

/** Gruppe in der Notizliste nach Bearbeitungszeit (lokales Datum) */
export function noteGroup(n: { pinned: boolean; updatedAt: string }, today: string): NoteGroup {
  if (n.pinned) return 'pinned';
  const d = new Date(n.updatedAt);
  const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const days = Math.round((Date.parse(`${today}T12:00:00`) - Date.parse(`${local}T12:00:00`)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return 'week';
  if (days < 30) return 'month';
  return 'older';
}

/** Wörter im Klartext zählen */
export function wordCount(text: string): number {
  return (text.match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu) ?? []).length;
}
