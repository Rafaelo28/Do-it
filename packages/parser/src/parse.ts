import {
  addDays,
  addMonths,
  addYears,
  daysInMonth,
  endOfMonth,
  firstOccurrence,
  fromParts,
  isoWeekday,
  isValidDate,
  makeTime,
  minutesToTime,
  nextOccurrence,
  nextWeekday,
  startOfIsoWeek,
  timeToMinutes,
  toParts,
  type PlainDate,
  type PlainTime,
  type Recurrence,
} from '@do-it/shared';
import {
  de,
  foldUmlauts,
  HOLIDAY_PATTERN,
  holidayDate,
  HOUR,
  MONTH_ANY,
  MONTH_FULL,
  NUM,
  ORD,
  parseHourToken,
  parseMonth,
  parseNumber,
  parseOrdinal,
  parseWeekday,
  rx,
  WD_ANY,
  WD_FULL,
  WD_PLURAL,
} from './lexicon';
import { findCompoundProjects, findImplicitProjects, fold, type ProjectRef } from './projects';

// ---------- Öffentliche Typen ----------

export interface TimeSettings {
  morning: PlainTime;
  forenoon: PlainTime;
  noon: PlainTime;
  afternoon: PlainTime;
  evening: PlainTime;
  night: PlainTime;
  workEnd: PlainTime;
}

export const DEFAULT_TIMES: TimeSettings = {
  morning: '08:00',
  forenoon: '10:00',
  noon: '12:00',
  afternoon: '15:00',
  evening: '19:00',
  night: '21:00',
  workEnd: '17:00',
};

export interface ParseContext {
  /** heutiges Datum in der Zeitzone des Nutzers */
  today: PlainDate;
  /** aktuelle Uhrzeit in der Zeitzone des Nutzers */
  now: PlainTime;
  userId?: string;
  projects?: ProjectRef[];
  members?: { id: string; name: string }[];
  labels?: string[];
  times?: Partial<TimeSettings>;
  /** erkannte Textstellen, die der Nutzer bewusst als normalen Text behalten will */
  ignore?: string[];
}

export type SpanType =
  | 'date'
  | 'time'
  | 'recurrence'
  | 'reminder'
  | 'deadline'
  | 'duration'
  | 'priority'
  | 'project'
  | 'label'
  | 'assignee'
  | 'rotation';

export interface Span {
  start: number;
  end: number;
  type: SpanType;
  text: string;
  /** nur erkannt, nicht aus dem Titel entfernt (z. B. Projektname im Satz) */
  implicit?: boolean;
}

export type ParsedReminder = { kind: 'relative'; offsetMin: number } | { kind: 'absolute'; date: PlainDate; time: PlainTime };

export interface ParseResult {
  title: string;
  dueDate: PlainDate | null;
  dueTime: PlainTime | null;
  deadline: PlainDate | null;
  recurrence: Recurrence | null;
  durationMin: number | null;
  /** 1 = höchste, 4 = keine */
  priority: 1 | 2 | 3 | 4;
  projectId: string | null;
  projectVia: 'explicit' | 'name' | 'alias' | null;
  /** #Name, für den es noch kein Projekt gibt */
  newProjectName: string | null;
  labels: string[];
  assigneeId: string | null;
  rotation: string[];
  reminders: ParsedReminder[];
  spans: Span[];
  /** mehrere Projekte passen: Auswahl anbieten */
  projectSuggestions: string[];
  warnings: string[];
}

// ---------- Interne Typen ----------

type Tod = 'morning' | 'forenoon' | 'noon' | 'afternoon' | 'evening' | 'night' | 'workEnd';

type Payload =
  | { k: 'date'; date: PlainDate; time?: PlainTime; tod?: Tod; src?: 'weekday' | 'explicit' | 'day' | 'month'; day?: number; ym?: [number, number] }
  | { k: 'time'; time: PlainTime; tod?: Tod; numeric?: { h: number; m: number; shifted: boolean }; durationMin?: number }
  | { k: 'recurrence'; rec: Recurrence; time?: PlainTime; tod?: Tod }
  | { k: 'after' }
  | { k: 'duration'; min: number }
  | { k: 'relReminder'; offsetMin: number }
  | { k: 'eveReminder' }
  | { k: 'remMarker' }
  | { k: 'deadlineMarker'; strict: boolean }
  | { k: 'offset'; days: number }
  | { k: 'priority'; p: 1 | 2 | 3 | 4 }
  | { k: 'project'; id: string | null; name: string }
  | { k: 'label'; name: string }
  | { k: 'assignee'; id: string }
  | { k: 'rotation'; ids: string[]; unknown: string[] };

interface Ctx extends ParseContext {
  t: TimeSettings;
  input: string;
  lower: string;
}

interface Cand {
  start: number;
  end: number;
  prio: number;
  p: Payload;
  used?: boolean;
}

type Groups = Record<string, string | undefined>;
type Build = (g: Groups, c: Ctx, m: RegExpExecArray) => Payload | null;

interface Rule {
  prio: number;
  re: RegExp;
  build: Build;
}

const RULES: Rule[] = [];
function rule(prio: number, pattern: string, build: Build): void {
  RULES.push({ prio, re: rx(pattern), build });
}

// ---------- Hilfen ----------

const PRIO_EXPLICIT = 100;
const PRIO_REMINDER = 95;
const PRIO_MARKER = 92;
const PRIO_RECURRENCE = 90;
const PRIO_AFTER = 89;
const PRIO_ROTATION = 88;
const PRIO_RELATIVE = 85;
const PRIO_OFFSET = 83;
const PRIO_DATE = 80;
const PRIO_TIME = 75;
const PRIO_DURATION = 70;
const PRIO_PRIORITY = 60;

function weekStart(c: Ctx): PlainDate {
  return startOfIsoWeek(c.today);
}

function inWeek(c: Ctx, weeks: number, wd: number): PlainDate {
  return addDays(weekStart(c), 7 * weeks + wd - 1);
}

function weekOffsetFromWord(word: string | undefined): number | null {
  if (!word) return null;
  const w = fold(word);
  if (w.startsWith('uebernaechst')) return 2;
  if (w.startsWith('naechst')) return 1;
  if (w.startsWith('dies')) return 0;
  if (w.startsWith('kommend')) return -1; // "kommende" = das nächste Vorkommen
  return null;
}

function unitMinutes(u: string): number {
  const x = fold(u);
  if (x.startsWith('m')) return 1;
  if (x.startsWith('s') || x.startsWith('h')) return 60;
  if (x.startsWith('t')) return 1440;
  if (x.startsWith('w')) return 10080;
  return 1;
}

function todOf(word: string): Tod | null {
  const w = fold(word);
  if (/fruehstueck|frueh|morgen/.test(w)) return 'morning';
  if (/vormittag/.test(w)) return 'forenoon';
  if (/nachmittag/.test(w)) return 'afternoon';
  if (/mittag/.test(w)) return 'noon';
  if (/feierabend|arbeit/.test(w)) return 'workEnd';
  if (/spaetabend|nacht/.test(w)) return 'night';
  if (/abend/.test(w)) return 'evening';
  return null;
}

function todTime(c: Ctx, tod: Tod): PlainTime {
  return c.t[tod];
}

/**
 * Stunde auflösen. Ohne Zusatz gilt: "um 3" ist nachmittags (15:00), "um 7" morgens.
 * Mit "Uhr" oder Doppelpunkt werden nur 1–5 Uhr als Nachmittag gedeutet.
 */
function resolveHour(h: number, m: number, q: string | undefined, exact: boolean): { h: number; m: number; shifted: boolean } | null {
  if (h > 24 || m > 59) return null;
  if (h === 24) h = 0;
  const tod = q ? todOf(q) : null;
  if (tod) {
    if ((tod === 'afternoon' || tod === 'evening' || tod === 'workEnd') && h < 12) h += 12;
    else if (tod === 'noon' && h < 11) h += 12;
    else if (tod === 'night' && h === 12) h = 0;
    else if (tod === 'night' && h >= 7 && h < 12) h += 12;
    return { h, m, shifted: false };
  }
  const limit = exact ? 5 : 6;
  if (h >= 1 && h <= limit) return { h: h + 12, m, shifted: true };
  return { h, m, shifted: false };
}

function timePayload(h: number, m: number, q: string | undefined, exact: boolean): Payload | null {
  const r = resolveHour(h, m, q, exact);
  if (!r) return null;
  return { k: 'time', time: makeTime(r.h, r.m), numeric: r, tod: q ? (todOf(q) ?? undefined) : undefined };
}

/** Datum ohne Jahr: dieses Jahr, oder nächstes, wenn schon vorbei. */
function futureDate(c: Ctx, d: number, m: number, y?: number): PlainDate | null {
  if (y !== undefined) return isValidDate(y, m, d) ? fromParts(y, m, d) : null;
  const ty = toParts(c.today)[0];
  for (let year = ty; year < ty + 8; year++) {
    if (!isValidDate(year, m, d)) continue;
    const date = fromParts(year, m, d);
    if (date >= c.today) return date;
  }
  return null;
}

function yearOf(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = Number(s);
  return s.length === 2 ? 2000 + n : n;
}

/** Tag für "anfang/mitte/ende" eines Monats. */
function monthPart(y: number, m: number, part: string | undefined): PlainDate {
  const p = part ? fold(part) : 'anfang';
  if (p.startsWith('mitte')) return fromParts(y, m, 15);
  if (p.startsWith('ende') || p.startsWith('letzt')) return endOfMonth(fromParts(y, m, 1));
  return fromParts(y, m, 1);
}

function lowerPreserve(s: string): string {
  let out = '';
  for (const ch of s) {
    const l = ch.toLowerCase();
    out += l.length === ch.length ? l : ch;
  }
  return out;
}

const Q = '(?<q>frühmorgens|früh|morgens|vormittags|mittags|nachmittags|abends|nachts|in\\s+der\\s+früh|in\\s+der\\s+nacht)';
const UNIT = '(?<u>minuten|minute|min\\.?|m|stunden|stunde|std\\.?|h|tagen|tage|tag|wochen|woche)';
const REM = '(?:mit\\s+)?(?:erinnere?\\s+mich|erinnerung|reminder)';
const BEFORE = '(?:vorher|davor|zuvor|früher|vor\\s+(?:dem\\s+|der\\s+)?(?:termin|beginn|start|anfang|losgehen))';
const SEP = '\\s*(?:,|und|&|\\+|sowie)\\s*';

// ---------- Regeln: Erinnerungen ----------

rule(PRIO_REMINDER, `${REM}\\s*:?\\s+(?:(?:jeweils|immer)\\s+)?(?<n>${NUM})\\s*${UNIT}\\s+${BEFORE}`, (g) => {
  const n = parseNumber(g.n);
  return n === null ? null : { k: 'relReminder', offsetMin: Math.round(n * unitMinutes(g.u!)) };
});
rule(PRIO_REMINDER, `(?<n>${NUM})\\s*${UNIT}\\s+${BEFORE}(?:\\s+(?:erinnern(?:\\s+lassen)?|erinnert\\s+werden|erinnerung|benachrichtigen|bescheid\\s+(?:sagen|geben)))?`, (g) => {
  const n = parseNumber(g.n);
  return n === null ? null : { k: 'relReminder', offsetMin: Math.round(n * unitMinutes(g.u!)) };
});
rule(PRIO_REMINDER, `(?:${REM}\\s+)?am\\s+vortag`, () => ({ k: 'relReminder', offsetMin: 1440 }));
rule(PRIO_REMINDER, `(?:${REM}\\s+)?(?:am\\s+vorabend|am\\s+abend\\s+(?:vorher|davor))`, () => ({ k: 'eveReminder' }));
rule(PRIO_REMINDER, `(?:sag|gib)\\s+mir\\s+(?<n>${NUM})\\s*${UNIT}\\s+(?:vorher|davor|zuvor)\\s+bescheid`, (g) => {
  const n = parseNumber(g.n);
  return n === null ? null : { k: 'relReminder', offsetMin: Math.round(n * unitMinutes(g.u!)) };
});
rule(PRIO_REMINDER, `${REM}\\s+(?:zur\\s+fälligkeit|pünktlich|zum\\s+termin|rechtzeitig)`, () => ({ k: 'relReminder', offsetMin: 0 }));
rule(PRIO_MARKER + 2, `${REM}(?:\\s*:)?`, () => ({ k: 'remMarker' }));
rule(PRIO_MARKER, `(?:deadline|frist|abgabefrist|fällig\\s+spätestens)(?:\\s*:)?(?:\\s+(?:ist|am|bis|zum))?`, () => ({ k: 'deadlineMarker', strict: true }));
// weichere Deadline-Wörter: nur wenn ein Datum folgt, sonst bleiben sie normaler Text
rule(PRIO_MARKER, `(?:(?:bis\\s+)?spätestens(?:\\s+(?:am|bis|zum))?|abgabe(?:termin|datum)?(?:\\s*:)?(?:\\s+(?:ist|am|bis|zum))?)`, () => ({ k: 'deadlineMarker', strict: false }));

// ---------- Regeln: Wiederholungen ----------

const rec = (r: Omit<Recurrence, 'interval'> & { interval?: number }, extra: Partial<Extract<Payload, { k: 'recurrence' }>> = {}): Payload => ({
  k: 'recurrence',
  rec: { interval: 1, ...r },
  ...extra,
});

function weekdayList(list: string): number[] {
  const out: number[] = [];
  for (const part of list.split(/\s*(?:,|und|&|\+|sowie)\s*/)) {
    const wd = parseWeekday(part.trim());
    if (wd && !out.includes(wd)) out.push(wd);
  }
  return out.sort();
}

rule(PRIO_RECURRENCE, 'täglich|tagtäglich|jeden\\s+(?:einzelnen\\s+)?tag|alle\\s+tage', () => rec({ freq: 'day' }));
rule(PRIO_RECURRENCE, `alle\\s+(?<n>${NUM})\\s+tage[n]?`, (g) => {
  const n = parseNumber(g.n);
  return n && Number.isInteger(n) ? rec({ freq: 'day', interval: n }) : null;
});
rule(PRIO_RECURRENCE, `jeden\\s+(?<o>${ORD})\\s+tag`, (g) => {
  const n = parseOrdinal(g.o);
  return n && n > 0 ? rec({ freq: 'day', interval: n }) : null;
});
rule(
  PRIO_RECURRENCE,
  'werktags|werktäglich|an\\s+werktagen|jeden\\s+werktag|(?:jeden\\s+)?(?:montag|mo\\.?)\\s*(?:-|–|bis)\\s*(?:freitag|fr\\.?)|montags\\s*(?:-|–|bis)\\s*freitags',
  () => rec({ freq: 'week', weekdays: [1, 2, 3, 4, 5] }),
);
rule(
  PRIO_RECURRENCE + 1,
  `(?:täglich|jeden\\s+tag)\\s+(?:außer|bis\\s+auf)\\s+(?:am\\s+|an\\s+|den\\s+)?(?:(?<we>wochenende[n]?)|(?<list>(?:${WD_ANY}|${WD_PLURAL})(?:${SEP}(?:${WD_ANY}|${WD_PLURAL}))*))`,
  (g) => {
    if (g.we) return rec({ freq: 'week', weekdays: [1, 2, 3, 4, 5] });
    const skip = weekdayList(g.list!);
    const days = [1, 2, 3, 4, 5, 6, 7].filter((d) => !skip.includes(d));
    return days.length ? rec({ freq: 'week', weekdays: days }) : null;
  },
);
rule(PRIO_RECURRENCE, 'jedes\\s+wochenende|an\\s+wochenenden|wochenends|an\\s+jedem\\s+wochenende', () => rec({ freq: 'week', weekdays: [6, 7] }));
rule(
  PRIO_RECURRENCE,
  `(?:wöchentlich|jede\\s+woche|einmal\\s+(?:pro|die|in\\s+der)\\s+woche)(?:\\s+(?:am\\s+|jeweils\\s+)?(?<wd>${WD_ANY}|${WD_PLURAL}))?`,
  (g) => {
    const wd = parseWeekday(g.wd);
    return rec({ freq: 'week', ...(wd ? { weekdays: [wd] } : {}) });
  },
);
rule(
  PRIO_RECURRENCE,
  `(?:alle\\s+(?<n>${NUM})\\s+wochen|(?<w>zwei|drei|vier)wöchentlich|zweiwöchig|vierzehntägig|vierzehntäglich|jede\\s+(?<o>${ORD})\\s+woche)(?:\\s+(?:am\\s+|jeweils\\s+)?(?<wd>${WD_ANY}|${WD_PLURAL}))?`,
  (g) => {
    const n = g.n ? parseNumber(g.n) : g.w ? parseNumber(g.w) : g.o ? parseOrdinal(g.o) : 2;
    if (!n || !Number.isInteger(n) || n < 1) return null;
    const wd = parseWeekday(g.wd);
    return rec({ freq: 'week', interval: n, ...(wd ? { weekdays: [wd] } : {}) });
  },
);
rule(PRIO_RECURRENCE, `jeden\\s+(?<list>${WD_ANY}(?:${SEP}${WD_ANY})*)`, (g, c, m) => {
  if (/^jeden\s+so$/.test(m[0])) return null;
  const days = weekdayList(g.list!);
  return days.length ? rec({ freq: 'week', weekdays: days }) : null;
});
rule(PRIO_RECURRENCE, `(?<list>(?:${WD_PLURAL})(?:${SEP}(?:${WD_PLURAL}))*)`, (g) => {
  const days = weekdayList(g.list!);
  return days.length ? rec({ freq: 'week', weekdays: days }) : null;
});
rule(
  PRIO_RECURRENCE + 1,
  `(?:jeden\\s+(?<wd>${WD_FULL})(?<tod>morgen|vormittag|mittag|nachmittag|abend)|(?<wd2>${WD_FULL})(?<tod2>morgen|vormittag|mittag|nachmittag|abend|nacht)s)`,
  (g, c) => {
    const wd = parseWeekday(g.wd ?? g.wd2);
    const tod = todOf(g.tod ?? g.tod2 ?? '');
    return wd && tod ? rec({ freq: 'week', weekdays: [wd] }, { time: todTime(c, tod), tod }) : null;
  },
);
rule(PRIO_RECURRENCE, `jeden\\s+(?<o>${ORD})\\s+(?<wd>${WD_ANY})`, (g) => {
  const n = parseOrdinal(g.o);
  const wd = parseWeekday(g.wd);
  if (!n || !wd) return null;
  if (n === 1 || n === -1) return rec({ freq: 'month', nthWeekday: { n, weekday: wd } });
  return rec({ freq: 'week', interval: n, weekdays: [wd] });
});
rule(
  PRIO_RECURRENCE + 1,
  `(?:jeden|immer\\s+am|am)\\s+(?<o>${ORD})\\s+(?<wd>${WD_ANY})\\s+(?:im\\s+monat|jeden\\s+monats|jedes\\s+monats|eines\\s+jeden\\s+monats|eines\\s+monats|des\\s+monats)`,
  (g, c, m) => {
    const n = parseOrdinal(g.o);
    const wd = parseWeekday(g.wd);
    if (!n || !wd || n > 5) return null;
    // "am letzten Freitag des Monats" ohne "jeden" ist ein einzelner Termin.
    if (/^am\s/.test(m[0]) && /des\s+monats$/.test(m[0])) return null;
    return rec({ freq: 'month', nthWeekday: { n, weekday: wd } });
  },
);
rule(
  PRIO_RECURRENCE,
  `(?:monatlich|jeden\\s+monat|einmal\\s+(?:im|pro)\\s+monat)(?:\\s+(?:am|zum|jeweils\\s+am)\\s+(?:(?<d>\\d{1,2})\\.|(?<last>letzten|monatsende|monatsletzten|ende)))?`,
  (g) => rec({ freq: 'month', ...(g.d ? { monthDay: Number(g.d) } : g.last ? { monthDay: -1 } : {}) }),
);
rule(
  PRIO_RECURRENCE,
  '(?:jeden|immer\\s+am|am)\\s+(?<d>\\d{1,2})\\.\\s*(?:des\\s+monats|im\\s+monat|jeden\\s+monats|jedes\\s+monats|eines\\s+monats)',
  (g, c, m) => {
    const d = Number(g.d);
    if (d < 1 || d > 31) return null;
    if (/^am\s/.test(m[0]) && /des\s+monats$/.test(m[0])) return null;
    return rec({ freq: 'month', monthDay: d });
  },
);
rule(PRIO_RECURRENCE, `jeden\\s+(?<d>\\d{1,2})\\.(?!\\s*(?:\\d|${MONTH_ANY}))`, (g) => {
  const d = Number(g.d);
  return d >= 1 && d <= 31 ? rec({ freq: 'month', monthDay: d }) : null;
});
rule(
  PRIO_RECURRENCE,
  'jeden\\s+(?:monatsersten|ersten\\s+(?:tag\\s+)?(?:des|im|eines)\\s+monats?)|(?:jeweils|immer)\\s+zum\\s+monatsersten|monatlich\\s+zum\\s+ersten',
  () => rec({ freq: 'month', monthDay: 1 }),
);
rule(
  PRIO_RECURRENCE,
  'jeden\\s+(?:monatsletzten|letzten\\s+(?:tag\\s+)?(?:des|im|eines)\\s+monats?)|jedes\\s+monatsende|zu\\s+jedem\\s+monatsende|(?:immer|jeweils)\\s+zum\\s+monatsende',
  () => rec({ freq: 'month', monthDay: -1 }),
);
rule(
  PRIO_RECURRENCE,
  `(?:alle\\s+(?<n>${NUM})\\s+monate[n]?|(?<q>vierteljährlich|quartalsweise|quartalsmäßig|jedes\\s+quartal|einmal\\s+im\\s+quartal)|(?<h>halbjährlich|jedes\\s+halbe\\s+jahr)|(?<z>zweimonatlich))(?:\\s+am\\s+(?<d>\\d{1,2})\\.)?`,
  (g) => {
    const n = g.n ? parseNumber(g.n) : g.q ? 3 : g.h ? 6 : 2;
    if (!n || !Number.isInteger(n)) return null;
    return rec({ freq: 'month', interval: n, ...(g.d ? { monthDay: Number(g.d) } : {}) });
  },
);
rule(
  PRIO_RECURRENCE,
  `(?:jährlich|alljährlich|jedes\\s+jahr|einmal\\s+im\\s+jahr)(?:\\s+(?:am\\s+)?(?<d>\\d{1,2})\\.\\s*(?:(?<mon>${MONTH_ANY})|(?<mm>\\d{1,2})\\.?))?`,
  (g) => {
    if (!g.d) return rec({ freq: 'year' });
    const month = g.mon ? parseMonth(g.mon) : Number(g.mm);
    const d = Number(g.d);
    if (!month || month > 12 || d < 1 || d > 31) return null;
    return rec({ freq: 'year', month, monthDay: d });
  },
);
rule(PRIO_RECURRENCE, `jeden\\s+(?<d>\\d{1,2})\\.\\s*(?:(?<mon>${MONTH_ANY})|(?<mm>\\d{1,2})\\.?)`, (g) => {
  const month = g.mon ? parseMonth(g.mon) : Number(g.mm);
  const d = Number(g.d);
  if (!month || month > 12 || d < 1 || d > 31) return null;
  return rec({ freq: 'year', month, monthDay: d });
});
rule(PRIO_RECURRENCE, `alle\\s+(?<n>${NUM})\\s+jahre[n]?`, (g) => {
  const n = parseNumber(g.n);
  return n && Number.isInteger(n) ? rec({ freq: 'year', interval: n }) : null;
});
rule(PRIO_RECURRENCE, 'jeden\\s+(?<tod>morgen|vormittag|mittag|nachmittag|abend)|jede\\s+nacht|allmorgendlich|allabendlich', (g, c, m) => {
  const tod = todOf(g.tod ?? m[0]);
  return tod ? rec({ freq: 'day' }, { time: todTime(c, tod), tod }) : null;
});
rule(
  PRIO_AFTER,
  '(?:nach|ab|seit)\\s+(?:der\\s+|dem\\s+|letzter\\s+)?(?:erledigung|abschluss|fertigstellung|erledigen|abhaken)|nachdem\\s+(?:es|sie)\\s+erledigt\\s+(?:ist|wurde)',
  () => ({ k: 'after' }),
);

// ---------- Regeln: Rotation ----------

rule(PRIO_ROTATION, `abwechselnd\\s+(?:(?<mit>mit)\\s+)?(?<names>\\p{L}[\\p{L}\\-]*(?:\\s*(?:,|und|&)\\s*\\p{L}[\\p{L}\\-]*)*)`, (g, c) => {
  const names = g.names!.split(/\s*(?:,|und|&)\s*/).filter(Boolean);
  const ids: string[] = [];
  const unknown: string[] = [];
  if (g.mit && c.userId) ids.push(c.userId);
  for (const n of names) {
    const id = findMember(c, n);
    if (id) {
      if (!ids.includes(id)) ids.push(id);
    } else unknown.push(n);
  }
  return ids.length ? { k: 'rotation', ids, unknown } : null;
});

function findMember(c: ParseContext, token: string): string | null {
  const t = fold(token);
  if (t.length < 2) return null;
  const members = c.members ?? [];
  const exact = members.filter((m) => fold(m.name) === t || fold(m.name).split(/\s+/)[0] === t);
  if (exact.length === 1) return exact[0]!.id;
  const prefix = members.filter((m) => fold(m.name).startsWith(t));
  return prefix.length === 1 ? prefix[0]!.id : null;
}

// ---------- Regeln: relative Zeitangaben ----------

rule(PRIO_RELATIVE, `in\\s+(?<n>${NUM})\\s*(?<u>minuten|minute|min\\.?|stunden|stunde|std\\.?|h)`, (g, c) => {
  const n = parseNumber(g.n);
  if (n === null) return null;
  const total = timeToMinutes(c.now) + Math.round(n * unitMinutes(g.u!));
  return { k: 'date', date: addDays(c.today, Math.floor(total / 1440)), time: minutesToTime(total) };
});
rule(PRIO_RELATIVE - 1, `(?:(?<base>heute|morgen)\\s+)?in\\s+(?<n>${NUM})\\s+(?<u>tagen|tage|tag|wochen|woche|monaten|monate|monat|jahren|jahre|jahr)`, (g, c) => {
  const n = parseNumber(g.n);
  if (n === null || !Number.isInteger(n)) return null;
  const base = g.base === 'morgen' ? addDays(c.today, 1) : c.today;
  const u = fold(g.u!);
  if (u.startsWith('tag')) return { k: 'date', date: addDays(base, n) };
  if (u.startsWith('woch')) return { k: 'date', date: addDays(base, 7 * n) };
  if (u.startsWith('monat')) return { k: 'date', date: addMonths(base, n) };
  return { k: 'date', date: addYears(base, n) };
});
rule(PRIO_RELATIVE - 1, `(?<wd>${WD_ANY})\\s+in\\s+(?<n>${NUM})\\s+wochen?|in\\s+(?<n2>${NUM})\\s+wochen?\\s+am\\s+(?<wd2>${WD_ANY})`, (g, c) => {
  const wd = parseWeekday(g.wd ?? g.wd2);
  const n = parseNumber(g.n ?? g.n2);
  return wd && n && Number.isInteger(n) ? { k: 'date', date: inWeek(c, n, wd) } : null;
});
rule(
  PRIO_OFFSET,
  `(?<n>${NUM})\\s+(?<u>tagen|tage|tag|wochen|woche)\\s+(?<dir>vor|nach)(?:\\s+(?:dem|der|den))?|(?:am\\s+)?tag\\s+(?<dir2>vor|nach)(?:\\s+(?:dem|der|den))?`,
  (g) => {
    const n = g.n ? parseNumber(g.n) : 1;
    if (!n || !Number.isInteger(n)) return null;
    const days = n * (g.u && fold(g.u).startsWith('woch') ? 7 : 1);
    return { k: 'offset', days: (g.dir ?? g.dir2) === 'vor' ? -days : days };
  },
);

// ---------- Regeln: Daten ----------

rule(PRIO_DATE + 1, 'heute\\s+(?:morgen|früh|vormittag)', (g, c, m) => {
  const tod = /vormittag/.test(m[0]) ? 'forenoon' : 'morning';
  return { k: 'date', date: c.today, time: todTime(c, tod), tod };
});
rule(PRIO_DATE + 1, 'heute\\s+nacht', (g, c) => ({ k: 'date', date: c.today, time: c.t.night, tod: 'night' }));
rule(PRIO_DATE, 'heute|heut', (g, c) => ({ k: 'date', date: c.today }));
rule(PRIO_DATE, 'übermorgen', (g, c) => ({ k: 'date', date: addDays(c.today, 2) }));
rule(PRIO_DATE, de('(?<!(?<![\\p{L}])(?:heute|am|jeden|guten|früh|zum|den|der|von)\\s+)morgen'), (g, c) => ({ k: 'date', date: addDays(c.today, 1) }));
rule(
  PRIO_DATE,
  `(?:(?<mod>diese[nmrs]?|kommende[nmrs]?|nächste[nmrs]?|übernächste[nmrs]?)\\s+)?(?<wd>${WD_ANY})(?:\\s+(?:in\\s+der\\s+)?(?<wk>nächste[nr]?|übernächste[nr]?|diese[nr]?|kommende[nr]?)\\s+woche)?`,
  (g, c) => {
    if (!g.mod && !g.wk && g.wd === 'so') return null;
    const wd = parseWeekday(g.wd);
    if (!wd) return null;
    return { k: 'date', date: weekdayDate(c, wd, g.mod ?? g.wk), src: 'weekday' };
  },
);
rule(
  PRIO_DATE + 1,
  `(?:(?<mod>diese[nmrs]?|kommende[nmrs]?|nächste[nmrs]?|übernächste[nmrs]?)\\s+)?(?<wd>${WD_FULL})(?<tod>morgen|vormittag|mittag|nachmittag|abend|nacht)`,
  (g, c) => {
    const wd = parseWeekday(g.wd);
    const tod = todOf(g.tod!);
    if (!wd || !tod) return null;
    return { k: 'date', date: weekdayDate(c, wd, g.mod), time: todTime(c, tod), tod };
  },
);
rule(PRIO_DATE, `(?<wk>nächste|kommende|übernächste|diese)\\s+woche\\s+(?:am\\s+)?(?<wd>${WD_ANY})`, (g, c) => {
  const wd = parseWeekday(g.wd);
  return wd ? { k: 'date', date: weekdayDate(c, wd, g.wk) } : null;
});

function weekdayDate(c: Ctx, wd: number, mod: string | undefined): PlainDate {
  const off = weekOffsetFromWord(mod);
  if (off === 1 || off === 2) return inWeek(c, off, wd);
  if (off === 0) return nextWeekday(c.today, wd, true);
  return nextWeekday(c.today, wd, false);
}

rule(
  PRIO_DATE,
  '(?:(?<part>anfang|mitte|ende)\\s+(?:der\\s+)?)?(?:in\\s+der\\s+)?(?<wk>nächste[nr]?|kommende[nr]?|übernächste[nr]?)\\s+woche',
  (g, c) => {
    const off = weekOffsetFromWord(g.wk) === 2 ? 2 : 1;
    const part = g.part ? fold(g.part) : 'anfang';
    const wd = part === 'mitte' ? 3 : part === 'ende' ? 5 : 1;
    return { k: 'date', date: inWeek(c, off, wd) };
  },
);
rule(
  PRIO_DATE,
  '(?<part>anfang|mitte|ende)\\s+(?:der|dieser|diese)\\s+woche|diese\\s+woche|im\\s+laufe\\s+der\\s+woche|wochenmitte|unter\\s+der\\s+woche',
  (g, c) => {
    const part = g.part ? fold(g.part) : 'ende';
    const wd = part === 'mitte' ? 3 : part === 'anfang' ? 1 : 5;
    const d = inWeek(c, 0, wd);
    return { k: 'date', date: d >= c.today ? d : c.today };
  },
);
rule(PRIO_DATE, '(?:(?<mod>nächste[ns]?|kommende[ns]?|übernächste[ns]?|diese[ns]?|diesem)\\s+)?wochenende', (g, c) => {
  const off = weekOffsetFromWord(g.mod);
  if (off === 1 || off === 2) return { k: 'date', date: inWeek(c, off, 6) };
  const wd = isoWeekday(c.today);
  return { k: 'date', date: wd >= 6 ? c.today : inWeek(c, 0, 6) };
});
rule(PRIO_DATE, '(?<d>\\d{1,2})\\.(?<m>\\d{1,2})\\.(?:(?<y>\\d{4}|\\d{2})(?!\\d))?|(?<d2>\\d{1,2})\\.(?<m2>\\d{1,2})(?![.\\d])', (g, c, m) => {
  const before = c.lower.slice(Math.max(0, m.index - 4), m.index);
  const after = c.lower.slice(m.index + m[0].length, m.index + m[0].length + 5);
  if (/(?:um|gegen)\s$/.test(before) && !g.y && g.d2) return null;
  if (g.d2) {
    // "2.5" ohne Schlusspunkt ist meist eine Zahl; als Datum nur mit Präposition/Wochentag oder zweistellig ("24.12")
    const wide = c.lower.slice(Math.max(0, m.index - 16), m.index);
    const prep = /(?:^|\s)(?:am|zum|vom|den|bis(?:\s+zum)?|ab(?:\s+dem)?|spätestens|spaetestens|frist|deadline|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|mo|di|mi|do|fr|sa|so)\.?,?\s*$/u.test(wide);
    if (!prep && !(g.d2.length === 2 && g.m2!.length === 2)) return null;
  }
  if (/^\s*uhr/.test(after)) return null;
  const d = Number(g.d ?? g.d2);
  const mo = Number(g.m ?? g.m2);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = futureDate(c, d, mo, yearOf(g.y));
  return date ? { k: 'date', date, src: 'explicit' } : null;
});
rule(
  PRIO_DATE,
  `(?:am|zum|bis\\s+zum|bis|ab\\s+dem|ab)\\s+(?<d>\\d{1,2})\\.(?!\\s*(?:\\d|${MONTH_ANY}))(?:\\s+(?:des|dieses|diesen)\\s+monats)?`,
  (g, c) => {
    const d = Number(g.d);
    if (d < 1 || d > 31) return null;
    const [y, m] = toParts(c.today);
    for (let k = 0; k < 14; k++) {
      const total = y * 12 + (m - 1) + k;
      const yy = Math.floor(total / 12);
      const mm = (total % 12) + 1;
      if (d > daysInMonth(yy, mm)) continue;
      const date = fromParts(yy, mm, d);
      if (date >= c.today) return { k: 'date', date, src: 'day', day: d };
    }
    return null;
  },
);
rule(PRIO_DATE, '(?<y>\\d{4})-(?<m>\\d{2})-(?<d>\\d{2})', (g) => {
  const y = Number(g.y);
  const mo = Number(g.m);
  const d = Number(g.d);
  return isValidDate(y, mo, d) ? { k: 'date', date: fromParts(y, mo, d), src: 'explicit' } : null;
});
rule(PRIO_DATE, `(?:(?<d>\\d{1,2})\\.?|(?<o>${ORD}))\\s*(?<mon>${MONTH_ANY})(?:\\s+(?<y>\\d{4}))?`, (g, c) => {
  const d = g.d ? Number(g.d) : parseOrdinal(g.o);
  const mo = parseMonth(g.mon);
  if (!d || d < 1 || !mo) return null;
  const date = futureDate(c, d, mo, yearOf(g.y));
  return date ? { k: 'date', date, src: 'explicit' } : null;
});
rule(PRIO_DATE, `(?<part>anfang|mitte|ende)\\s+(?<mon>${MONTH_FULL})(?:\\s+(?<y>\\d{4}))?|im\\s+(?<mon2>${MONTH_FULL})(?:\\s+(?<y2>\\d{4}))?`, (g, c) => {
  const mo = parseMonth(g.mon ?? g.mon2);
  if (!mo) return null;
  const ty = toParts(c.today)[0];
  const y = yearOf(g.y ?? g.y2);
  let date = monthPart(y ?? ty, mo, g.part);
  if (!y && endOfMonth(date) < c.today) date = monthPart(ty + 1, mo, g.part);
  if (date < c.today) date = c.today;
  const [dy, dm] = toParts(date);
  return { k: 'date', date, ...(g.part ? {} : { src: 'month' as const, ym: [dy, dm] as [number, number] }) };
});
rule(
  PRIO_DATE,
  '(?<p1>anfang|mitte|ende)\\s+(?:des|dieses|diesen)\\s+monats|(?<p2>anfang|mitte|ende)\\s+(?:des\\s+)?monat|monats(?<p3>anfang|mitte|ende|ersten|letzten)',
  (g, c) => {
    const part = g.p1 ?? g.p2 ?? g.p3;
    const [y, m] = toParts(c.today);
    let date = monthPart(y, m, part === 'ersten' ? 'anfang' : part);
    if (date < c.today) {
      const next = addMonths(fromParts(y, m, 1), 1);
      const [ny, nm] = toParts(next);
      date = monthPart(ny, nm, part === 'ersten' ? 'anfang' : part);
    }
    return { k: 'date', date };
  },
);
rule(
  PRIO_DATE,
  '(?:(?<part>anfang|mitte|ende)\\s+(?:des\\s+)?)?(?:im\\s+)?(?<nm>nächste[nr]?|kommende[nr]?|übernächste[nr]?)\\s+monats?',
  (g, c) => {
    const [y, m] = toParts(c.today);
    const n = fold(g.nm!).startsWith('uebernaechst') ? 2 : 1;
    const [ny, nm] = toParts(addMonths(fromParts(y, m, 1), n));
    return { k: 'date', date: monthPart(ny, nm, g.part), ...(g.part ? {} : { src: 'month' as const, ym: [ny, nm] as [number, number] }) };
  },
);
rule(PRIO_DATE, '(?<part>anfang|mitte|ende)\\s+(?:des|dieses|diesen)\\s+jahres|jahres(?<p2>ende|anfang|mitte)', (g, c) => {
  const part = fold(g.part ?? g.p2!);
  const y = toParts(c.today)[0];
  const pick = (yy: number) => (part === 'ende' ? fromParts(yy, 12, 31) : part === 'mitte' ? fromParts(yy, 7, 1) : fromParts(yy, 1, 1));
  const d = pick(y);
  return { k: 'date', date: d >= c.today ? d : pick(y + 1) };
});
rule(PRIO_DATE, '(?:(?<part>anfang|mitte|ende)\\s+(?:des\\s+)?)?(?:im\\s+)?(?:nächste[ns]?|kommende[ns]?)\\s+jahr(?:es)?', (g, c) => {
  const y = toParts(c.today)[0] + 1;
  const part = g.part ? fold(g.part) : 'anfang';
  return { k: 'date', date: part === 'ende' ? fromParts(y, 12, 31) : part === 'mitte' ? fromParts(y, 7, 1) : fromParts(y, 1, 1) };
});
rule(PRIO_DATE + 1, `(?<h>${HOLIDAY_PATTERN})`, (g, c) => {
  const date = holidayDate(g.h!, c.today);
  return date ? { k: 'date', date } : null;
});
rule(PRIO_DATE, '(?:kw|kalenderwoche)\\s*(?<w>\\d{1,2})', (g, c) => {
  const w = Number(g.w);
  if (w < 1 || w > 53) return null;
  const isoWeekMonday = (y: number) => addDays(startOfIsoWeek(fromParts(y, 1, 4)), 7 * (w - 1));
  const y = toParts(c.today)[0];
  const d = isoWeekMonday(y);
  return { k: 'date', date: addDays(d, 6) >= c.today ? (d >= c.today ? d : c.today) : isoWeekMonday(y + 1) };
});

rule(
  PRIO_DATE + 1,
  `(?:(?<part>anfang|mitte|ende)\\s+|im\\s+)(?<mon>${MONTH_FULL})\\s+(?:des\\s+)?(?:nächsten|kommenden)\\s+jahres|(?:nächstes|kommendes)\\s+jahr\\s+(?:(?<part2>anfang|mitte|ende)|im)\\s+(?<mon2>${MONTH_FULL})`,
  (g, c) => {
    const mo = parseMonth(g.mon ?? g.mon2);
    if (!mo) return null;
    return { k: 'date', date: monthPart(toParts(c.today)[0] + 1, mo, g.part ?? g.part2) };
  },
);
const SEASONS: Record<string, number> = { frühjahr: 3, frühling: 3, sommer: 6, herbst: 9, winter: 12 };
rule(PRIO_DATE, '(?:im|zum|ab)\\s+(?<s>frühjahr|frühling|sommer|herbst|winter)', (g, c) => {
  const startMonth = SEASONS[foldUmlauts(g.s!)] ?? 3;
  const y = toParts(c.today)[0];
  for (const year of [y - 1, y, y + 1]) {
    const start = fromParts(year, startMonth, 1);
    const end = addDays(addMonths(start, 3), -1);
    if (c.today >= start && c.today <= end) return { k: 'date', date: c.today };
    if (start > c.today) return { k: 'date', date: start };
  }
  return null;
});

// ---------- Regeln: Uhrzeiten ----------

function rangePayload(h1: number, m1: number, h2: number, m2: number): Payload | null {
  const a = resolveHour(h1, m1, undefined, true);
  if (!a) return null;
  let b = resolveHour(h2, m2, undefined, true);
  if (!b) return null;
  let start = a.h * 60 + a.m;
  let end = b.h * 60 + b.m;
  if (a.shifted && !b.shifted && end > start - 720 && end < start) {
    // "14–3 Uhr" kommt nicht vor; "10–2 Uhr" wird 10–14 Uhr
  }
  if (end <= start && b.h + 12 < 24) end += 720;
  if (end <= start) return null;
  b = { ...b };
  return { k: 'time', time: makeTime(a.h, a.m), numeric: a, durationMin: end - start };
}

rule(
  PRIO_TIME + 2,
  '(?:von\\s+)?(?<h1>\\d{1,2})(?:[:.](?<m1>\\d{2}))?\\s*(?:uhr\\s*)?(?:-|–|bis)\\s*(?<h2>\\d{1,2})(?:[:.](?<m2>\\d{2}))?\\s*uhr|von\\s+(?<h3>\\d{1,2})(?:[:.](?<m3>\\d{2}))?\\s*(?:uhr\\s*)?bis\\s+(?<h4>\\d{1,2})(?:[:.](?<m4>\\d{2}))?|(?<h5>\\d{1,2}):(?<m5>\\d{2})\\s*(?:-|–|bis)\\s*(?<h6>\\d{1,2}):(?<m6>\\d{2})',
  (g) => {
    const h1 = Number(g.h1 ?? g.h3 ?? g.h5);
    const m1 = Number(g.m1 ?? g.m3 ?? g.m5 ?? 0);
    const h2 = Number(g.h2 ?? g.h4 ?? g.h6);
    const m2 = Number(g.m2 ?? g.m4 ?? g.m6 ?? 0);
    return rangePayload(h1, m1, h2, m2);
  },
);
rule(PRIO_TIME + 1, `(?:um\\s+|gegen\\s+|ab\\s+)?(?<h>\\d{1,2})(?:[:.](?<m>\\d{2}))?\\s*uhr(?:\\s+${Q})?`, (g) =>
  timePayload(Number(g.h), Number(g.m ?? 0), g.q, true),
);
rule(PRIO_TIME + 1, `(?:um|gegen|ab)\\s+(?<h>\\d{1,2})\\s*h(?:\\s*(?<m>\\d{2}))?`, (g) => timePayload(Number(g.h), Number(g.m ?? 0), undefined, true));
rule(PRIO_TIME, `(?:um\\s+|gegen\\s+|ab\\s+)?(?<h>\\d{1,2}):(?<m>\\d{2})(?:\\s*h)?(?:\\s+${Q})?`, (g) =>
  timePayload(Number(g.h), Number(g.m), g.q, true),
);
rule(PRIO_TIME, `(?:um|gegen|ab)\\s+(?<h>${HOUR})(?:\\.(?<m>\\d{2}))?(?:\\s+${Q})?`, (g) => {
  const h = parseHourToken(g.h);
  return h === null ? null : timePayload(h, Number(g.m ?? 0), g.q, false);
});
rule(PRIO_TIME, `(?:um\\s+|gegen\\s+|ab\\s+)?halb\\s+(?<h>${HOUR})(?:\\s+${Q})?`, (g) => {
  const h = parseHourToken(g.h);
  return h === null || h < 1 ? null : timePayload(h - 1 === 0 ? 12 : h - 1, 30, g.q, false);
});
rule(PRIO_TIME, `(?:um\\s+|gegen\\s+)?(?:viertel\\s+(?<dir>nach|vor)|(?<dv>dreiviertel))\\s+(?<h>${HOUR})(?:\\s+${Q})?`, (g) => {
  const h = parseHourToken(g.h);
  if (h === null) return null;
  if (g.dir === 'nach') return timePayload(h, 15, g.q, false);
  return timePayload(h - 1 <= 0 ? 12 : h - 1, 45, g.q, false);
});
rule(
  PRIO_TIME,
  `(?:um\\s+|gegen\\s+)?(?<mn>\\d{1,2}|fünf|zehn|zwanzig)\\s+(?<dir>nach|vor)\\s+(?<halb>halb\\s+)?(?<h>${HOUR})(?:\\s+${Q})?`,
  (g) => {
    const h = parseHourToken(g.h);
    const mn = parseNumber(g.mn);
    if (h === null || mn === null || mn >= 30) return null;
    let base = h * 60;
    if (g.halb) base -= 30;
    const total = g.dir === 'nach' ? base + mn : base - mn;
    const hh = Math.floor(((total % 720) + 720) % 720 / 60) || 12;
    return timePayload(hh, ((total % 60) + 60) % 60, g.q, false);
  },
);
rule(
  PRIO_TIME - 1,
  '(?:am\\s+|gegen\\s+)?(?<tod>frühmorgens|früh|morgens|vormittags?|mittags?|nachmittags?|abends?|spätabends|nachts|in\\s+der\\s+früh|in\\s+der\\s+nacht|zum\\s+frühstück|zum\\s+mittagessen|zu\\s+mittag|zum\\s+abendessen|nach\\s+(?:dem\\s+)?feierabend|nach\\s+der\\s+arbeit)|am\\s+(?<tod2>morgen)',
  (g, c) => {
    const tod = todOf(g.tod ?? g.tod2 ?? '');
    return tod ? { k: 'time', time: todTime(c, tod), tod } : null;
  },
);

rule(PRIO_TIME, '(?:um|bis|gegen|vor)\\s+mitternacht|mitternacht', () => ({ k: 'time', time: '23:59', numeric: { h: 23, m: 59, shifted: false }, tod: 'night' }));
rule(PRIO_TIME, 'nach\\s+dem\\s+(?<meal>frühstück|mittagessen|abendessen)', (g, c) => {
  const base = /fr(?:ü|ue)hst/.test(g.meal!) ? c.t.morning : /mittag/.test(g.meal!) ? c.t.noon : c.t.evening;
  const time = minutesToTime(timeToMinutes(base) + 60);
  const [h, m] = time.split(':').map(Number) as [number, number];
  return { k: 'time', time, numeric: { h, m, shifted: false }, tod: 'afternoon' };
});

// ---------- Regeln: Dauer und Priorität ----------

rule(
  PRIO_DURATION,
  `(?:(?:für|ca\\.?|circa|etwa|dauer:?|dauert)\\s+)?(?:(?<n>${NUM})\\s*(?<u>minuten|minute|min\\.?|stunden|stunde|std\\.?|h)|(?<hh>\\d+)\\s*h\\s*(?<mm>\\d{1,2})(?:\\s*min)?|(?<n2>\\d+)m|(?<n3>\\d+(?:[.,]\\d+)?|ein|zwei|drei)stündig)`,
  (g) => {
    if (g.hh) return { k: 'duration', min: Number(g.hh) * 60 + Number(g.mm) };
    if (g.n2) return { k: 'duration', min: Number(g.n2) };
    if (g.n3) {
      const n = parseNumber(g.n3);
      return n ? { k: 'duration', min: Math.round(n * 60) } : null;
    }
    const n = parseNumber(g.n);
    if (!n) return null;
    const min = Math.round(n * unitMinutes(g.u!));
    return min > 0 && min <= 10080 ? { k: 'duration', min } : null;
  },
);
rule(PRIO_DURATION + 1, `(?<n>${NUM})\\s*(?<u>minuten|minute|min\\.?|stunden|stunde|std\\.?|h)\\s+lang`, (g) => {
  const n = parseNumber(g.n);
  const min = n ? Math.round(n * unitMinutes(g.u!)) : 0;
  return min > 0 && min <= 10080 ? { k: 'duration', min } : null;
});
rule(PRIO_DURATION + 1, `(?:(?:für|dauert|dauer:?)\\s+(?<n>${NUM})\\s*(?:tage|tag)|(?<n2>${NUM})\\s*(?:tage|tag)\\s+lang)`, (g) => {
  const n = parseNumber(g.n ?? g.n2!);
  return n && n > 0 && n <= 7 ? { k: 'duration', min: Math.round(n * 1440) } : null;
});
rule(PRIO_PRIORITY, 'dringend|asap|schnellstmöglich|so\\s+schnell\\s+wie\\s+möglich|sehr\\s+wichtig|höchste\\s+priorität|hohe\\s+priorität|prio(?:rität)?\\s*(?<n>[1-4])|wichtig', (g, c, m) => {
  if (g.n) return { k: 'priority', p: Number(g.n) as 1 | 2 | 3 | 4 };
  if (/dringend|asap|schnellst|so\s+schnell|sehr|höchste|hoechste/.test(m[0])) return { k: 'priority', p: 1 };
  return { k: 'priority', p: 2 };
});

// ---------- Explizite Marker: #Projekt, @Label, +Person, !1 ----------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function explicitMarkers(c: Ctx, out: Cand[]): void {
  const { input } = c;
  const projects = [...(c.projects ?? [])].sort((a, b) => b.name.length - a.name.length);

  // Emojis und Zeichen im Projektnamen ("🏡 Privat", "Privat & Familie") zählen beim Tippen nicht mit
  const nameWords = (name: string) => name.replace(/[^\p{L}\p{N}\s\-_]+/gu, ' ').trim().split(/[\s\-_]+/).filter(Boolean);
  const matchProject = (rest: string): { id: string; name: string; len: number } | null => {
    for (const p of projects) {
      for (const name of [p.name, ...(p.aliases ?? [])]) {
        const words = nameWords(name).map((w) => escapeRe(w.toLowerCase()));
        if (!words.length) continue;
        const re = new RegExp(`^${de(words.join('[^\\p{L}\\p{N}#@]{1,3}'))}(?![\\p{L}\\p{N}])`, 'iu');
        const mm = re.exec(rest);
        if (mm) return { id: p.id, name: p.name, len: mm[0].length };
      }
    }
    // Eindeutiger Anfang ab 3 Zeichen: ".ges" → Gesundheit
    const tok = /^[\p{L}\p{N}_\-]+/u.exec(rest)?.[0];
    if (!tok || tok.length < 3) return null;
    const f = fold(tok).replace(/[^\p{L}\p{N}]+/gu, '');
    const hits = projects.filter((p) => !p.isInbox && [p.name, ...(p.aliases ?? [])].some((n) => fold(n).replace(/[^\p{L}\p{N}]+/gu, '').startsWith(f)));
    return hits.length === 1 ? { id: hits[0]!.id, name: hits[0]!.name, len: tok.length } : null;
  };

  // #Projekt: bestehendes Projekt oder Vorschlag für ein neues
  for (const m of input.matchAll(/(?<=^|\s)#/g)) {
    const at = m.index + 1;
    const rest = input.slice(at);
    const hit = matchProject(rest);
    if (hit) {
      out.push({ start: m.index, end: at + hit.len, prio: PRIO_EXPLICIT, p: { k: 'project', id: hit.id, name: hit.name } });
      continue;
    }
    const tok = /^[^\s#@]+/.exec(rest)?.[0]?.replace(/[.,;:!?)]+$/, '');
    if (tok) out.push({ start: m.index, end: at + tok.length, prio: PRIO_EXPLICIT, p: { k: 'project', id: null, name: tok } });
  }

  // .Projekt: Kurzform (leicht auf dem Handy zu tippen), nur für bestehende Projekte
  for (const m of input.matchAll(/(?<=^|\s)\.(?=\p{L})/gu)) {
    const at = m.index + 1;
    const hit = matchProject(input.slice(at));
    if (hit) out.push({ start: m.index, end: at + hit.len, prio: PRIO_EXPLICIT, p: { k: 'project', id: hit.id, name: hit.name } });
  }

  for (const m of input.matchAll(/(?<=^|\s)@([\p{L}\p{N}_\-]+)/gu)) {
    const raw = m[1]!;
    const known = (c.labels ?? []).find((l) => l.toLowerCase() === raw.toLowerCase());
    out.push({ start: m.index, end: m.index + m[0].length, prio: PRIO_EXPLICIT, p: { k: 'label', name: known ?? raw } });
  }

  for (const m of input.matchAll(/(?<=^|\s)\+(\p{L}[\p{L}\-]*)/gu)) {
    const id = findMember(c, m[1]!);
    if (id) out.push({ start: m.index, end: m.index + m[0].length, prio: PRIO_EXPLICIT, p: { k: 'assignee', id } });
  }

  for (const m of input.matchAll(/(?<=^|\s)(?:!|p)([1-4])(?![\p{L}\p{N}])/giu)) {
    out.push({ start: m.index, end: m.index + m[0].length, prio: PRIO_EXPLICIT, p: { k: 'priority', p: Number(m[1]) as 1 | 2 | 3 | 4 } });
  }
  for (const m of input.matchAll(/(?<=^|\s)(!{2,3})(?=\s|$)/g)) {
    out.push({ start: m.index, end: m.index + m[0].length, prio: PRIO_EXPLICIT, p: { k: 'priority', p: m[1]!.length === 3 ? 1 : 2 } });
  }
}

// ---------- Titel ----------

const FILLER_BEFORE =
  /(?:^|\s)(?:am|um|bis|ab|an|im|zum|zur|zu|in|für|fuer|gegen|spätestens|spaetestens|ca\.|circa|etwa|jeweils|immer|bereits|schon|noch|dann|und\s+zwar|also|den|oder)\s*$/iu;
const GAP_FILLER = /^[\s,:;]*(?:(?:um|am|an|zum|zur|bis|ab|den|dem|der|für|auf)\s+)*[\s,:;]*$/iu;

function buildTitle(input: string, removed: [number, number][], reminderAtStart: boolean): string {
  const ranges = removed.map(([a, b]) => [a, b] as [number, number]);
  // Füllwörter vor entfernten Stellen mit entfernen ("am Montag" → "")
  for (const r of ranges) {
    for (;;) {
      const before = input.slice(0, r[0]);
      const m = FILLER_BEFORE.exec(before);
      if (!m) break;
      const start = before.length - m[0].length + (m[0].startsWith(' ') ? 1 : 0);
      if (ranges.some((o) => o !== r && start < o[1] && o[0] < r[0])) break;
      r[0] = start;
    }
    const after = /^\s+noch(?![\p{L}])/u.exec(input.slice(r[1]));
    if (after) r[1] += after[0].length;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [a, b] of ranges) {
    if (a > pos) out += input.slice(pos, a) + ' ';
    pos = Math.max(pos, b);
  }
  out += input.slice(pos);
  let t = out
    .replace(/\s+/g, ' ')
    .replace(/\s+([,;:!?]|\.(?![\p{L}\p{N}]))/gu, '$1')
    .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
    .replace(/^[\s,;:\-–—]+/, '')
    .replace(/[\s,;:\-–—]+$/, '')
    .replace(/\s+(?:und|oder|sowie|mit)$/i, '')
    .trim();
  if (reminderAtStart) {
    t = t.replace(/^(?:an\s+(?:den|die|das|dem|meinen|meine|mein)?\s*|daran,?\s*(?:dass\s+)?|dass\s+(?:ich\s+)?|zu\s+)/iu, '').trim();
  }
  if (!t) return t;
  const first = /^\S+/u.exec(t)![0];
  // Abkürzungen ("z.B.") und Markennamen mit Großbuchstaben im Wort ("iPhone") nicht anfassen
  if (/^\p{Ll}\.\p{Ll}?\.?/u.test(first) || /\p{Lu}/u.test(first.slice(1))) return t;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const WORD_BEFORE_KEEP = new Set(
  'beim bei mit für fuer von vom zum zur im am an auf aus in ins den dem der die das des ein eine einen einem einer wegen über ueber unter nach vor ohne gegen um zu fürs ans aufs meinem meinen meiner unserem unseren'.split(' '),
);

/**
 * Steht ein im Satz erkannter Projektname wie ein Etikett am Rand ("Zahnarzt anrufen Gesundheit",
 * "Gesundheit: Zahnarzt anrufen", "Haushalt Fenster putzen"), wird er aus dem Titel entfernt.
 * Gehört er zum Satz ("Garten umgraben", "Rasen mähen im Garten"), bleibt er stehen.
 */
function tagLikeRange(input: string, m: { start: number; end: number }, removed: [number, number][]): [number, number] | null {
  const covered = (i: number) => removed.some(([a, b]) => i >= a && i < b);
  const isWord = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch);
  let lead = true;
  for (let i = 0; i < m.start; i++) if (!covered(i) && isWord(input[i])) lead = false;
  let trail = true;
  for (let i = m.end; i < input.length; i++) if (!covered(i) && isWord(input[i])) trail = false;
  if (lead === trail) return null;
  if (lead) {
    const sep = /^\s*[:\-–—/|]\s*/u.exec(input.slice(m.end));
    if (sep) return [m.start, m.end + sep[0].length];
    let i = m.end;
    while (i < input.length && (covered(i) || !isWord(input[i]))) i++;
    const ch = input[i];
    return ch && ch !== ch.toLowerCase() ? [m.start, m.end] : null;
  }
  let i = m.start - 1;
  while (i >= 0 && (covered(i) || !isWord(input[i]))) i--;
  let j = i;
  while (j >= 0 && isWord(input[j]) && !covered(j)) j--;
  const prev = input.slice(j + 1, i + 1).toLowerCase();
  if (!prev || WORD_BEFORE_KEEP.has(prev)) return null;
  const sepBefore = /\s*[:\-–—/|,]\s*$/u.exec(input.slice(0, m.start));
  return [sepBefore ? m.start - sepBefore[0].length : m.start, m.end];
}

const WARN_PATTERNS: [RegExp, (m: RegExpExecArray) => string][] = [
  [/\d{1,2}(?:[:.]\d{2})?\s*uhr/iu, (m) => `„${m[0]}“ nicht als Uhrzeit verstanden`],
  [/(?<![\p{L}])(?:übernächste|naechste|nächste|kommende)[nmrs]?\s+\p{L}+/iu, (m) => `„${m[0]}“ nicht verstanden`],
  [/(?<![\p{L}])(?:anfang|mitte|ende)\s+\p{L}+/iu, (m) => `„${m[0]}“ nicht verstanden`],
  [/(?<![\p{L}])(?:nach|vor)\s+(?:dem|der|den)\s+(?:urlaub|ferien|wochenende|feiertagen|umzug)/iu, (m) => `„${m[0]}“ kann kein Datum ergeben`],
  [/(?<![\p{L}])(?:in|nach)\s+(?:ein\s+paar|einigen|mehreren)\s+(?:tagen|wochen|monaten)/iu, (m) => `„${m[0]}“ ist zu ungenau`],
];

// ---------- Parser ----------

export function parseTask(input: string, context: ParseContext): ParseResult {
  const c: Ctx = { ...context, t: { ...DEFAULT_TIMES, ...context.times }, input, lower: lowerPreserve(input) };
  const ignore = new Set((context.ignore ?? []).map((s) => s.trim().toLowerCase()));

  const cands: Cand[] = [];
  explicitMarkers(c, cands);
  for (const r of RULES) {
    r.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = r.re.exec(c.lower))) {
      if (!m[0]) {
        r.re.lastIndex++;
        continue;
      }
      const p = r.build((m.groups ?? {}) as Groups, c, m);
      if (p) cands.push({ start: m.index, end: m.index + m[0].length, prio: r.prio, p });
    }
  }

  const usable = cands.filter((cd) => !ignore.has(input.slice(cd.start, cd.end).trim().toLowerCase()));
  usable.sort((a, b) => b.prio - a.prio || b.end - b.start - (a.end - a.start) || a.start - b.start);
  const chosen: Cand[] = [];
  for (const cd of usable) if (!chosen.some((o) => cd.start < o.end && o.start < cd.end)) chosen.push(cd);
  chosen.sort((a, b) => a.start - b.start);

  const result: ParseResult = {
    title: '',
    dueDate: null,
    dueTime: null,
    deadline: null,
    recurrence: null,
    durationMin: null,
    priority: 4,
    projectId: null,
    projectVia: null,
    newProjectName: null,
    labels: [],
    assigneeId: null,
    rotation: [],
    reminders: [],
    spans: [],
    projectSuggestions: [],
    warnings: [],
  };

  const removed: [number, number][] = [];
  const addSpan = (start: number, end: number, type: SpanType) => {
    result.spans.push({ start, end, type, text: input.slice(start, end) });
    removed.push([start, end]);
  };
  const gapOk = (a: Cand, b: Cand | undefined) => !!b && GAP_FILLER.test(input.slice(a.end, b.start));

  let dateCand: (Cand & { p: { k: 'date' } }) | null = null;
  let dateBeforeWord = '';
  const times: Extract<Payload, { k: 'time' }>[] = [];
  let recurrence: Recurrence | null = null;
  let recTime: Extract<Payload, { k: 'recurrence' }>['time'];
  let recTod: Tod | undefined;
  let after = false;
  let remAbs: { date?: PlainDate; time?: PlainTime } | null = null;
  let remPlain = false;
  let reminderAtStart = false;
  let eveReminder = false;
  let untilDate: PlainDate | null = null;
  let startDate: PlainDate | null = null;
  const extraDates: Cand[] = [];

  for (let i = 0; i < chosen.length; i++) {
    const cd = chosen[i]!;
    if (cd.used) continue;
    const p = cd.p;
    switch (p.k) {
      case 'remMarker': {
        if (cd.start === 0 || /^\s*$/.test(input.slice(0, cd.start))) reminderAtStart = true;
        let end = cd.end;
        let j = i + 1;
        const abs: { date?: PlainDate; time?: PlainTime } = {};
        let last: Cand = cd;
        while (j < chosen.length && gapOk(last, chosen[j])) {
          const nx = chosen[j]!;
          if (nx.p.k === 'date' && !abs.date) {
            abs.date = nx.p.date;
            if (nx.p.time && !abs.time) abs.time = nx.p.time;
          } else if (nx.p.k === 'time' && !abs.time) abs.time = nx.p.time;
          else if (nx.p.k === 'relReminder') {
            remPlain = false;
            break;
          } else break;
          nx.used = true;
          end = nx.end;
          last = nx;
          j++;
        }
        if (abs.date || abs.time) remAbs = abs;
        else if (!(chosen[j]?.p.k === 'relReminder' && gapOk(cd, chosen[j]))) remPlain = true;
        addSpan(cd.start, end, 'reminder');
        break;
      }
      case 'relReminder':
        result.reminders.push({ kind: 'relative', offsetMin: p.offsetMin });
        addSpan(cd.start, cd.end, 'reminder');
        break;
      case 'eveReminder':
        eveReminder = true;
        addSpan(cd.start, cd.end, 'reminder');
        break;
      case 'deadlineMarker': {
        const nx = chosen[i + 1];
        if (nx && nx.p.k === 'date' && gapOk(cd, nx)) {
          result.deadline = nx.p.date;
          nx.used = true;
          addSpan(cd.start, nx.end, 'deadline');
        } else if (p.strict) {
          result.warnings.push('Nach „Deadline“ fehlt ein Datum');
        }
        break;
      }
      case 'offset': {
        const nx = chosen[i + 1];
        if (nx && nx.p.k === 'date' && /^\s*$/.test(input.slice(cd.end, nx.start))) {
          nx.used = true;
          const shifted: Cand & { p: { k: 'date' } } = { ...nx, start: cd.start, p: { ...nx.p, date: addDays(nx.p.date, p.days) } };
          if (!dateCand) {
            dateCand = shifted;
            dateBeforeWord = input.slice(0, cd.start);
          } else extraDates.push(shifted);
          addSpan(cd.start, nx.end, 'date');
        }
        break;
      }
      case 'date': {
        const before = input.slice(0, cd.start).toLowerCase();
        if (!dateCand) {
          dateCand = cd as Cand & { p: { k: 'date' } };
          dateBeforeWord = before;
        } else {
          extraDates.push(cd);
        }
        addSpan(cd.start, cd.end, 'date');
        break;
      }
      case 'time':
        times.push(p);
        addSpan(cd.start, cd.end, 'time');
        break;
      case 'recurrence':
        if (!recurrence) {
          recurrence = { ...p.rec };
          recTime = p.time;
          recTod = p.tod;
          addSpan(cd.start, cd.end, 'recurrence');
        }
        break;
      case 'after':
        after = true;
        addSpan(cd.start, cd.end, 'recurrence');
        break;
      case 'duration':
        if (result.durationMin === null) {
          result.durationMin = p.min;
          addSpan(cd.start, cd.end, 'duration');
        }
        break;
      case 'priority':
        if (result.priority === 4 || cd.prio === PRIO_EXPLICIT) result.priority = p.p;
        addSpan(cd.start, cd.end, 'priority');
        break;
      case 'project':
        if (!result.projectId && !result.newProjectName) {
          if (p.id) {
            result.projectId = p.id;
            result.projectVia = 'explicit';
          } else result.newProjectName = p.name;
        }
        addSpan(cd.start, cd.end, 'project');
        break;
      case 'label':
        if (!result.labels.some((l) => l.toLowerCase() === p.name.toLowerCase())) result.labels.push(p.name);
        addSpan(cd.start, cd.end, 'label');
        break;
      case 'assignee':
        result.assigneeId ??= p.id;
        addSpan(cd.start, cd.end, 'assignee');
        break;
      case 'rotation':
        result.rotation = p.ids;
        result.assigneeId = p.ids[0] ?? null;
        for (const n of p.unknown) result.warnings.push(`„${n}“ ist kein Mitglied`);
        addSpan(cd.start, cd.end, 'rotation');
        break;
    }
  }

  // "nächsten Monat am 5." / "im Dezember am 3.": Tag im genannten Monat
  {
    const all = [dateCand, ...extraDates].filter((d): d is Cand & { p: { k: 'date' } } => !!d && d.p.k === 'date');
    const monthC = all.find((d) => d.p.src === 'month' && d.p.ym);
    const dayC = all.find((d) => d.p.src === 'day' && d.p.day);
    if (monthC && dayC) {
      const [yy, mm] = monthC.p.ym!;
      const date = fromParts(yy, mm, Math.min(dayC.p.day!, daysInMonth(yy, mm)));
      const first = monthC.start < dayC.start ? monthC : dayC;
      dateCand = { ...first, p: { k: 'date', date, src: 'explicit' } };
      for (let i = extraDates.length - 1; i >= 0; i--) if (extraDates[i] === monthC || extraDates[i] === dayC) extraDates.splice(i, 1);
    }
  }

  // "Montag, den 30.11.": das ausdrückliche Datum gewinnt, wenn der Wochentag dazu passt.
  if (dateCand && extraDates.length) {
    const main = dateCand as Cand & { p: { k: 'date' } };
    const sameDay = (a: Cand, b: Cand & { p: { k: 'date' } }) =>
      a.p.k === 'date' &&
      (a.p.date === b.p.date ||
        ((a.p.src === 'weekday' || b.p.src === 'weekday') && a.p.src !== b.p.src && isoWeekday(a.p.date) === isoWeekday(b.p.date)));
    const explicit = extraDates.find((d) => d.p.k === 'date' && d.p.src === 'explicit' && main.p.src === 'weekday' && sameDay(d, main));
    if (explicit) {
      extraDates.splice(extraDates.indexOf(explicit), 1);
      extraDates.push(main);
      dateCand = explicit as Cand & { p: { k: 'date' } };
    }
    for (let i = extraDates.length - 1; i >= 0; i--) if (sameDay(extraDates[i]!, dateCand as Cand & { p: { k: 'date' } })) extraDates.splice(i, 1);
  }

  // Wiederholung mit "bis"/"ab": Datum begrenzt bzw. startet die Serie.
  if (recurrence) {
    const all = [dateCand, ...extraDates].filter(Boolean) as Cand[];
    for (const d of all) {
      if (d.p.k !== 'date') continue;
      const before = input.slice(0, d.start).toLowerCase();
      if (/(?:^|\s)bis\s*(?:zum\s+|am\s+)?$/.test(before)) untilDate = d.p.date;
      else if (/(?:^|\s)(?:ab|ab\s+dem|beginnend)\s*(?:am\s+|dem\s+)?$/.test(before)) startDate = d.p.date;
    }
    if (untilDate && dateCand?.p.k === 'date' && dateCand.p.date === untilDate) dateCand = null;
    if (startDate && dateCand?.p.k === 'date' && dateCand.p.date === startDate) dateCand = null;
  } else if (extraDates.length) {
    result.warnings.push('Mehrere Daten gefunden – das erste wird verwendet');
  }
  void dateBeforeWord;

  // Uhrzeit bestimmen: Zahl schlägt Tageszeit, Tageszeit korrigiert vormittags/nachmittags.
  const numeric = times.find((t) => t.numeric);
  const todT = times.find((t) => !t.numeric && t.tod);
  const dateTod = dateCand?.p.k === 'date' ? dateCand.p.tod : undefined;
  const tod = todT?.tod ?? dateTod ?? recTod;
  let dueTime: PlainTime | null = null;
  if (numeric?.numeric) {
    let { h } = numeric.numeric;
    const { m, shifted } = numeric.numeric;
    if (!numeric.tod && tod) {
      if ((tod === 'afternoon' || tod === 'evening' || tod === 'workEnd') && h < 12) h += 12;
      else if ((tod === 'morning' || tod === 'forenoon') && shifted) h -= 12;
      else if (tod === 'night' && shifted && h < 19) h -= 12;
    }
    dueTime = makeTime(h, m);
    if (numeric.durationMin) result.durationMin ??= numeric.durationMin;
  } else if (todT) dueTime = todT.time;
  else if (dateCand?.p.k === 'date' && dateCand.p.time) dueTime = dateCand.p.time;
  else if (recTime) dueTime = recTime;

  let dueDate: PlainDate | null = dateCand?.p.k === 'date' ? dateCand.p.date : null;

  if (recurrence) {
    if (after) recurrence.afterCompletion = true;
    if (untilDate) recurrence.until = untilDate;
    if (!dueDate) {
      const from = startDate ?? c.today;
      dueDate = recurrence.afterCompletion ? from : firstOccurrence(recurrence, from);
      if (dueDate === c.today && dueTime && dueTime <= c.now) {
        dueDate = nextOccurrence(recurrence, c.today, c.today) ?? dueDate;
      }
    }
    result.recurrence = recurrence;
  } else if (after) {
    result.warnings.push('„nach Erledigung“ braucht eine Wiederholung, z. B. „alle 3 Tage“');
  }

  if (!dueDate && dueTime) dueDate = dueTime > c.now ? c.today : addDays(c.today, 1);

  // Erinnerungen
  if (remAbs) {
    if (!dueDate) {
      dueDate = remAbs.date ?? (remAbs.time && remAbs.time <= c.now ? addDays(c.today, 1) : c.today);
      dueTime ??= remAbs.time ?? null;
      result.reminders.push({ kind: 'relative', offsetMin: 0 });
    } else {
      result.reminders.push({ kind: 'absolute', date: remAbs.date ?? dueDate, time: remAbs.time ?? c.t.morning });
    }
  } else if (remPlain) {
    result.reminders.push({ kind: 'relative', offsetMin: 0 });
  }
  if (eveReminder) {
    if (dueDate) result.reminders.push({ kind: 'absolute', date: addDays(dueDate, -1), time: c.t.evening });
    else result.warnings.push('Erinnerung am Vorabend braucht ein Datum');
  }
  if (result.reminders.some((r) => r.kind === 'relative') && !dueDate) {
    result.warnings.push('Erinnerung braucht ein Datum');
  }

  result.dueDate = dueDate;
  result.dueTime = dueTime;

  // Projekte im Satz (ohne #)
  if (!result.projectId && !result.newProjectName && c.projects?.length) {
    const matches = findImplicitProjects(input, removed, c.projects);
    const ids = [...new Set(matches.map((m) => m.id))].filter((id) => !ignore.has(projectIgnoreKey(input, matches, id)));
    if (ids.length === 1) {
      result.projectId = ids[0]!;
      result.projectVia = matches.find((m) => m.id === ids[0])!.via;
      for (const m of matches.filter((x) => x.id === ids[0])) {
        // Punkt oder # direkt davor: war als Kurzform gemeint, Zeichen mit entfernen
        const marked = m.start > 0 && '.#'.includes(input[m.start - 1]!) && (m.start === 1 || /\s/.test(input[m.start - 2]!));
        if (marked) result.projectVia = 'explicit';
        // abgeschnittener Projektname ("priv" für Privat) ist kein Wort im Satz: immer entfernen
        const strip: [number, number] | null = marked ? [m.start - 1, m.end] : m.fragment ? [m.start, m.end] : tagLikeRange(input, m, removed);
        if (strip) removed.push(strip);
        result.spans.push({ start: m.start, end: m.end, type: 'project', text: input.slice(m.start, m.end), ...(strip ? {} : { implicit: true }) });
      }
    } else if (ids.length > 1) {
      result.projectSuggestions = ids;
    } else {
      result.projectSuggestions = findCompoundProjects(input, removed, c.projects);
    }
  }

  result.spans.sort((a, b) => a.start - b.start);
  result.title = buildTitle(input, removed, reminderAtStart);

  const lowerTitle = result.title.toLowerCase();
  for (const [re, msg] of WARN_PATTERNS) {
    const m = re.exec(lowerTitle);
    if (m) result.warnings.push(msg(m));
  }
  return result;
}

function projectIgnoreKey(input: string, matches: { id: string; start: number; end: number }[], id: string): string {
  const m = matches.find((x) => x.id === id)!;
  return input.slice(m.start, m.end).trim().toLowerCase();
}

/** Mehrere Zeilen (z. B. eingefügte Liste) → mehrere Aufgaben. Aufzählungszeichen werden entfernt. */
export function parseMany(text: string, context: ParseContext): ParseResult[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•–]|\d+[.)]|\[\s?[xX ]?\])\s+/, '').trim())
    .filter(Boolean)
    .map((l) => parseTask(l, context));
}
