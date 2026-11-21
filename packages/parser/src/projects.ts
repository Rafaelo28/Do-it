export interface ProjectRef {
  id: string;
  name: string;
  aliases?: string[];
  isInbox?: boolean;
}

export interface ProjectMatch {
  id: string;
  start: number;
  end: number;
  via: 'name' | 'alias';
  tokens: number;
}

/** Kleinschreibung, Umlaute ausgeschrieben, Akzente entfernt. */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

function splitWords(s: string): string[] {
  return fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function levenshtein1(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    // Vertauschung zweier Buchstaben zählt als ein Fehler
    if (a[i] === b[j + 1] && a[i + 1] === b[j] && a.length === b.length) {
      i += 2;
      j += 2;
      continue;
    }
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** Wort im Text passt zu einem Wort im Projektnamen (Beugung und ein Tippfehler erlaubt). */
export function wordMatches(text: string, name: string): boolean {
  if (text === name) return true;
  const [long, short] = text.length >= name.length ? [text, name] : [name, text];
  if (short.length >= 4 && long.startsWith(short) && long.length - short.length <= 2) return true;
  return name.length >= 6 && levenshtein1(text, name);
}

interface Token {
  word: string;
  start: number;
  end: number;
  blocked: boolean;
}

/**
 * Sucht Projektnamen und Aliasse im Freitext. Bereiche in `blocked` (bereits erkannte Teile)
 * werden übersprungen. Ein Name aus mehreren Wörtern muss vollständig und zusammenhängend vorkommen.
 */
export function findImplicitProjects(input: string, blocked: [number, number][], projects: ProjectRef[]): ProjectMatch[] {
  const tokens: Token[] = [];
  for (const m of input.matchAll(/[\p{L}\p{N}]+/gu)) {
    const start = m.index;
    const end = start + m[0].length;
    tokens.push({ word: fold(m[0]), start, end, blocked: blocked.some(([a, b]) => start < b && a < end) });
  }

  const matches: ProjectMatch[] = [];
  for (const p of projects) {
    if (p.isInbox) continue;
    const variants: [string[], 'name' | 'alias'][] = [[splitWords(p.name), 'name']];
    for (const a of p.aliases ?? []) variants.push([splitWords(a), 'alias']);
    for (const [words, via] of variants) {
      if (!words.length || words.join('').length < 3) continue;
      for (let i = 0; i + words.length <= tokens.length; i++) {
        let ok = true;
        for (let k = 0; k < words.length; k++) {
          const t = tokens[i + k]!;
          if (t.blocked || !wordMatches(t.word, words[k]!)) {
            ok = false;
            break;
          }
        }
        if (ok) {
          matches.push({ id: p.id, start: tokens[i]!.start, end: tokens[i + words.length - 1]!.end, via, tokens: words.length });
        }
      }
    }
  }

  // Treffer, die in einem längeren Treffer stecken, fallen weg ("Haus" in "Haus Renovierung").
  return matches.filter(
    (m) => !matches.some((o) => o !== m && o.id !== m.id && o.start <= m.start && o.end >= m.end && o.end - o.start > m.end - m.start),
  );
}

/**
 * Wortzusammensetzungen ("Gartenschere" → Garten, "Arbeitszeugnis" → Arbeit) nur als Vorschlag,
 * weil sie oft nichts mit dem Projekt zu tun haben.
 */
export function findCompoundProjects(input: string, blocked: [number, number][], projects: ProjectRef[]): string[] {
  const words: string[] = [];
  for (const m of input.matchAll(/[\p{L}\p{N}]+/gu)) {
    const start = m.index;
    const end = start + m[0].length;
    if (!blocked.some(([a, b]) => start < b && a < end)) words.push(fold(m[0]));
  }
  const ids: string[] = [];
  for (const p of projects) {
    if (p.isInbox) continue;
    for (const name of [p.name, ...(p.aliases ?? [])]) {
      const parts = splitWords(name);
      if (parts.length !== 1) continue;
      const w = parts[0]!;
      const stems = [...new Set([w, w.replace(/en$/, ''), w.replace(/e$/, '')])].filter((s) => s.length >= 5);
      if (words.some((t) => stems.some((s) => t.startsWith(s) && t.length >= s.length + 3)) && !ids.includes(p.id)) ids.push(p.id);
    }
  }
  return ids;
}
