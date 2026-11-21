import { addDays, startOfIsoWeek, type PlainDate } from './dates';

/**
 * Filtersprache für eigene Filter – deutsch, versteht aber auch die gewohnten Todoist-Begriffe.
 *
 *   heute | überfällig            heute oder überfällig
 *   #Arbeit & p1                  Projekt Arbeit und Priorität 1
 *   ##Arbeit                      Projekt Arbeit samt Unterprojekten
 *   @einkaufen & !morgen          Label einkaufen, aber nicht morgen
 *   7 tage & !wiederkehrend       die nächsten 7 Tage ohne Wiederholungen
 *   deadline 14 tage              Deadline in den nächsten 14 Tagen
 *   (heute | morgen) & mir zugewiesen
 *
 * Verknüpfungen: & (und), | oder , (oder), ! oder "nicht " (nicht), Klammern.
 */

export interface FilterTask {
  title: string;
  description?: string;
  projectId: string;
  sectionId: string | null;
  parentId: string | null;
  priority: number;
  dueDate: string | null;
  dueTime: string | null;
  deadline: string | null;
  durationMin: number | null;
  recurrence: unknown;
  assigneeId: string | null;
  labels: string[];
  createdBy?: string | null;
}

export interface FilterContext {
  today: PlainDate;
  meId: string;
  projects: { id: string; name: string; parentId: string | null; isInbox?: boolean }[];
  sections: { id: string; name: string }[];
  members: { userId: string; name: string }[];
}

type Test = (t: FilterTask, c: FilterContext) => boolean;

export interface CompiledFilter {
  test: Test;
}

export type FilterResult = { ok: true; filter: CompiledFilter } | { ok: false; error: string };

type Token = { kind: 'op'; v: '&' | '|' | '(' | ')' | '!' } | { kind: 'term'; v: string };

function tokenize(q: string): Token[] {
  const out: Token[] = [];
  let buf = '';
  const flush = () => {
    if (buf.trim()) out.push({ kind: 'term', v: buf.trim() });
    buf = '';
  };
  for (let i = 0; i < q.length; i++) {
    const ch = q[i]!;
    if (ch === '&' || ch === '|' || ch === ',' || ch === '(' || ch === ')') {
      flush();
      out.push({ kind: 'op', v: ch === ',' ? '|' : (ch as '&' | '|' | '(' | ')') });
    } else if (ch === '!' && !buf.trim() && !/^[1-4](?![\p{L}\p{N}])/u.test(q.slice(i + 1))) {
      buf = '';
      out.push({ kind: 'op', v: '!' });
    } else buf += ch;
  }
  flush();
  return out;
}

class FilterError extends Error {}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Name mit * als Platzhalter vergleichen (ohne Groß-/Kleinschreibung). */
function matcher(pattern: string): (s: string) => boolean {
  const p = norm(pattern);
  if (!p.includes('*')) return (s) => norm(s) === p;
  const re = new RegExp(`^${p.split('*').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'u');
  return (s) => re.test(norm(s));
}

/** Datum in einer Abfrage: heute, morgen, gestern, 24.12., 24.12.2026, 2026-12-24, +3 / in 3 tagen */
function parseDate(raw: string, today: PlainDate): PlainDate | null {
  const s = norm(raw);
  if (s === 'heute' || s === 'today') return today;
  if (s === 'morgen' || s === 'tomorrow') return addDays(today, 1);
  if (s === 'gestern' || s === 'yesterday') return addDays(today, -1);
  let m = /^(?:\+|in )?(\d+) ?(?:tagen?|days?)?$/.exec(s);
  if (m && (s.startsWith('+') || s.startsWith('in '))) return addDays(today, Number(m[1]));
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return s;
  if ((m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})?$/.exec(s))) {
    const y = m[3] ? Number(m[3]) : Number(today.slice(0, 4));
    const d = `${y}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
    return m[3] || d >= today ? d : `${y + 1}${d.slice(4)}`;
  }
  return null;
}

/** Datumsbedingung für Fälligkeit oder Deadline */
function dateTerm(s: string, get: (t: FilterTask) => string | null): Test | null {
  if (/^(heute|today)$/.test(s)) return (t, c) => get(t) === c.today;
  if (/^(morgen|tomorrow)$/.test(s)) return (t, c) => get(t) === addDays(c.today, 1);
  if (/^(gestern|yesterday)$/.test(s)) return (t, c) => get(t) === addDays(c.today, -1);
  if (/^(überfällig|ueberfaellig|overdue|od)$/.test(s)) return (t, c) => !!get(t) && get(t)! < c.today;
  if (/^(diese woche|this week)$/.test(s)) return (t, c) => inRange(get(t), startOfIsoWeek(c.today), addDays(startOfIsoWeek(c.today), 6));
  if (/^(nächste woche|naechste woche|next week)$/.test(s)) return (t, c) => inRange(get(t), addDays(startOfIsoWeek(c.today), 7), addDays(startOfIsoWeek(c.today), 13));
  if (/^(wochenende|weekend|this weekend)$/.test(s)) {
    return (t, c) => {
      const sat = addDays(startOfIsoWeek(c.today), 5);
      return inRange(get(t), sat, addDays(sat, 1));
    };
  }
  let m = /^(?:nächste |naechste |next )?(\d{1,3}) ?(?:tage|tagen|days?)$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    return (t, c) => inRange(get(t), c.today, addDays(c.today, Math.max(0, n - 1)));
  }
  if ((m = /^(vor|before|nach|after|am|datum|date|on)\s*:\s*(.+)$/.exec(s))) {
    const [, op, raw] = m as unknown as [string, string, string];
    if (!parseDate(raw, '2000-01-01')) throw new FilterError(`Datum „${raw}“ nicht verstanden (z. B. 24.12. oder heute)`);
    return (t, c) => {
      const d = parseDate(raw, c.today)!;
      const v = get(t);
      if (!v) return false;
      return op === 'vor' || op === 'before' ? v < d : op === 'nach' || op === 'after' ? v > d : v === d;
    };
  }
  return null;
}

function inRange(d: string | null, from: PlainDate, to: PlainDate): boolean {
  return !!d && d >= from && d <= to;
}

function projectAndChildren(c: FilterContext, ids: Set<string>): Set<string> {
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of c.projects) {
      if (p.parentId && ids.has(p.parentId) && !ids.has(p.id)) {
        ids.add(p.id);
        grew = true;
      }
    }
  }
  return ids;
}

function term(raw: string): Test {
  const s = norm(raw);
  if (s === 'alle' || s === 'all' || s === '*') return () => true;

  // Fälligkeit
  if (/^(ohne datum|kein datum|no date|no due date)$/.test(s)) return (t) => !t.dueDate;
  if (/^(mit datum|has date|datum)$/.test(s)) return (t) => !!t.dueDate;
  if (/^(ohne uhrzeit|no time)$/.test(s)) return (t) => !!t.dueDate && !t.dueTime;
  if (/^(mit uhrzeit|has time)$/.test(s)) return (t) => !!t.dueTime;
  const due = dateTerm(s.replace(/^(fällig|faellig|due)\s+/, ''), (t) => t.dueDate);
  if (due) return due;

  // Deadline
  if (/^(deadline|mit deadline|has deadline)$/.test(s)) return (t) => !!t.deadline;
  if (/^(ohne deadline|keine deadline|no deadline)$/.test(s)) return (t) => !t.deadline;
  const dl = /^deadline\s*:?\s+(.+)$/.exec(s);
  if (dl) {
    const test = dateTerm(dl[1]!, (t) => t.deadline);
    if (test) return test;
    throw new FilterError(`„${raw}“: nach „deadline“ z. B. „heute“, „überfällig“, „7 tage“ oder „vor: 24.12.“`);
  }

  // Priorität
  const prio = /^(?:p|!|prio(?:rität|ritaet)?\s*|priority\s*)([1-4])$/.exec(s);
  if (prio) return (t) => t.priority === Number(prio[1]);

  // Projekt, Abschnitt, Label
  if (s.startsWith('##')) {
    const is = matcher(raw.trim().slice(2));
    const hit = (p: FilterContext['projects'][number]) => is(p.name) || (!!p.isInbox && (is('eingang') || is('inbox')));
    return (t, c) => projectAndChildren(c, new Set(c.projects.filter(hit).map((p) => p.id))).has(t.projectId);
  }
  if (s.startsWith('#')) {
    const is = matcher(raw.trim().slice(1));
    return (t, c) => {
      const p = c.projects.find((x) => x.id === t.projectId);
      return !!p && (is(p.name) || (!!p.isInbox && (is('eingang') || is('inbox'))));
    };
  }
  if (s.startsWith('/')) {
    const is = matcher(raw.trim().slice(1));
    return (t, c) => !!t.sectionId && is(c.sections.find((x) => x.id === t.sectionId)?.name ?? '');
  }
  if (s.startsWith('@')) {
    const is = matcher(raw.trim().slice(1));
    return (t) => t.labels.some(is);
  }
  if (/^(ohne labels?|keine labels?|no labels?)$/.test(s)) return (t) => t.labels.length === 0;

  // Zuständig
  if (/^(mir zugewiesen|zugewiesen an mich|zugewiesen an: ?(?:mich|ich|mir)|assigned to: ?me|assigned to me)$/.test(s)) return (t, c) => t.assigneeId === c.meId;
  if (/^(nicht zugewiesen|niemandem zugewiesen|unassigned|no assignee)$/.test(s)) return (t) => !t.assigneeId;
  if (/^(zugewiesen|assigned)$/.test(s)) return (t) => !!t.assigneeId;
  if (/^(anderen zugewiesen|assigned to: ?others|assigned to others)$/.test(s)) return (t, c) => !!t.assigneeId && t.assigneeId !== c.meId;
  const who = /^(?:zugewiesen an|assigned to)\s*:?\s+(.+)$/.exec(s);
  if (who) {
    const name = who[1]!;
    return (t, c) => {
      const m = c.members.find((x) => x.userId === t.assigneeId);
      return !!m && (norm(m.name) === name || norm(m.name).split(' ')[0] === name);
    };
  }
  if (/^(von mir erstellt|erstellt von mir|created by: ?me|added by: ?me)$/.test(s)) return (t, c) => t.createdBy === c.meId;

  // Sonstiges
  if (/^(wiederkehrend|wiederholend|recurring)$/.test(s)) return (t) => !!t.recurrence;
  if (/^(unteraufgaben?|subtasks?)$/.test(s)) return (t) => !!t.parentId;
  if (/^(mit dauer|has duration|dauer)$/.test(s)) return (t) => !!t.durationMin;
  const search = /^(?:suche|search|text)\s*:\s*(.+)$/.exec(s);
  if (search) {
    const q = search[1]!;
    return (t) => norm(t.title).includes(q) || norm(t.description ?? '').includes(q);
  }
  throw new FilterError(`„${raw.trim()}“ kenne ich nicht. Für eine Textsuche „suche: ${raw.trim()}“ schreiben.`);
}

export function parseFilter(query: string): FilterResult {
  try {
    const tokens = tokenize(query);
    if (!tokens.length) throw new FilterError('Die Abfrage ist leer.');
    let i = 0;
    const peek = () => tokens[i];
    const or = (): Test => {
      let left = and();
      while (peek()?.kind === 'op' && peek()!.v === '|') {
        i++;
        const a = left;
        const b = and();
        left = (t, c) => a(t, c) || b(t, c);
      }
      return left;
    };
    const and = (): Test => {
      let left = unary();
      while (peek()?.kind === 'op' && peek()!.v === '&') {
        i++;
        const a = left;
        const b = unary();
        left = (t, c) => a(t, c) && b(t, c);
      }
      return left;
    };
    const unary = (): Test => {
      const tok = peek();
      if (tok?.kind === 'op' && tok.v === '!') {
        i++;
        const a = unary();
        return (t, c) => !a(t, c);
      }
      return primary();
    };
    const primary = (): Test => {
      const tok = tokens[i++];
      if (!tok) throw new FilterError('Nach einer Verknüpfung fehlt noch etwas.');
      if (tok.kind === 'op' && tok.v === '(') {
        const inner = or();
        const close = tokens[i++];
        if (!close || close.kind !== 'op' || close.v !== ')') throw new FilterError('Eine Klammer wird nicht geschlossen.');
        return inner;
      }
      if (tok.kind === 'op') throw new FilterError(`Unerwartetes „${tok.v}“.`);
      // "nicht heute" als Schreibweise für "!heute" (aber "nicht zugewiesen" ist ein eigener Begriff)
      const neg = /^nicht\s+(.+)$/i.exec(tok.v);
      if (neg && !/^nicht\s+zugewiesen$/i.test(tok.v)) {
        const a = term(neg[1]!);
        return (t, c) => !a(t, c);
      }
      return term(tok.v);
    };
    const test = or();
    if (i < tokens.length) {
      const tok = tokens[i]!;
      throw new FilterError(tok.kind === 'op' && tok.v === ')' ? 'Eine Klammer zu viel.' : `Hier fehlt ein & oder | vor „${tok.v}“.`);
    }
    return { ok: true, filter: { test } };
  } catch (e) {
    if (e instanceof FilterError) return { ok: false, error: e.message };
    throw e;
  }
}

/** Offene Aufgaben, die zur Abfrage passen. */
export function applyFilter<T extends FilterTask & { completedAt: string | null }>(tasks: T[], query: string, ctx: FilterContext): { tasks: T[]; error: string | null } {
  const r = parseFilter(query);
  if (!r.ok) return { tasks: [], error: r.error };
  return { tasks: tasks.filter((t) => !t.completedAt && r.filter.test(t, ctx)), error: null };
}

export const FILTER_EXAMPLES: { query: string; text: string }[] = [
  { query: 'heute | überfällig', text: 'Heute fällig oder überfällig' },
  { query: '7 tage & !wiederkehrend', text: 'Die nächsten 7 Tage ohne Wiederholungen' },
  { query: 'p1 | p2', text: 'Priorität 1 oder 2' },
  { query: '#Arbeit & ohne datum', text: 'Projekt Arbeit, noch nicht eingeplant' },
  { query: '##Arbeit', text: 'Projekt Arbeit mit Unterprojekten' },
  { query: '@einkaufen', text: 'Label einkaufen' },
  { query: 'deadline 14 tage', text: 'Deadline in den nächsten 14 Tagen' },
  { query: 'mir zugewiesen & !heute', text: 'Mir zugewiesen, aber nicht heute' },
  { query: 'mit uhrzeit & diese woche', text: 'Termine dieser Woche' },
  { query: 'suche: rechnung', text: 'Titel oder Beschreibung enthält „rechnung“' },
];
