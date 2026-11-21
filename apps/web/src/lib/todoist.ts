import { parseTask } from '@do-it/parser';
import { generateNKeysBetween, uuidv7, zonedParts, type Me, type PlainDate, type PlainTime, type Recurrence } from '@do-it/shared';
import { isZip, unzip } from './zip';

/**
 * Import aus Todoist – auf zwei Wegen, beide landen im selben Zwischenformat (ImportPlan):
 *
 * 1. API-Schlüssel (empfohlen, geht in jedem Todoist-Tarif): ein vollständiger Abzug über die
 *    Sync-Schnittstelle mit Projekten, Unterprojekten, Abschnitten, Unteraufgaben, Labels,
 *    Kommentaren, Projektnotizen und Erinnerungen. Der Schlüssel bleibt im Browser.
 * 2. Backup (ZIP, nur Todoist Pro/Business) oder einzeln exportierte CSV-Dateien.
 *    Spalten: TYPE, CONTENT, DESCRIPTION, PRIORITY (1 = höchste), INDENT, AUTHOR, RESPONSIBLE,
 *    DATE, DATE_LANG, TIMEZONE, DURATION, DURATION_UNIT, DEADLINE, DEADLINE_LANG.
 *
 * Erledigte Aufgaben liefert Todoist in Backups und Exporten nicht mit; sie werden nicht übernommen.
 * Grundsatz: Keine offene Aufgabe geht verloren. Was sich nicht abbilden lässt (zu lange Texte,
 * unbekannte Datumsangaben, Zuständige), landet als Hinweis in der Beschreibung.
 */

// ---------- Zwischenformat ----------

export interface ImportComment {
  body: string;
  at: string | null;
}

export type ImportReminder = { kind: 'relative'; offsetMin: number } | { kind: 'absolute'; date: PlainDate; time: PlainTime };

export interface ImportTask {
  title: string;
  description: string;
  priority: 1 | 2 | 3 | 4;
  dueDate: PlainDate | null;
  dueTime: PlainTime | null;
  recurrence: Recurrence | null;
  durationMin: number | null;
  deadline: PlainDate | null;
  labels: string[];
  /** Schlüssel des Abschnitts im Projekt */
  section: string | null;
  comments: ImportComment[];
  reminders: ImportReminder[];
  children: ImportTask[];
}

export interface ImportProject {
  key: string;
  name: string;
  isInbox: boolean;
  parentKey: string | null;
  color: string | null;
  archived: boolean;
  sections: { key: string; name: string }[];
  tasks: ImportTask[];
}

export interface ImportPlan {
  source: 'api' | 'csv';
  projects: ImportProject[];
  labels: { name: string; color: string | null }[];
  taskCount: number;
  commentCount: number;
  reminderCount: number;
  warnings: string[];
}

export interface ImportContext {
  today: PlainDate;
  now: PlainTime;
  /** Zeitzone des Nutzers in Do-it (für Termine mit fester Zeitzone) */
  timeZone: string;
}

// Grenzen wie im Server-Schema – darüber würde der Server die Aufgabe ablehnen
const LIMIT = { title: 500, description: 20000, name: 120, label: 60, labels: 30, comment: 10000, duration: 10080 };
const NOTES_TITLE = 'Projektnotizen aus Todoist';

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function appendNote(description: string, note: string): string {
  return description ? `${description}\n\n${note}` : note;
}

/** Lange Kommentare auf mehrere aufteilen statt abzuschneiden. */
function splitComment(body: string): string[] {
  const text = body.trim();
  if (!text) return [];
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += LIMIT.comment - 20) {
    const part = text.slice(i, i + LIMIT.comment - 20).trim();
    if (part) parts.push(part);
  }
  return parts.length > 1 ? parts.map((p, i) => `(${i + 1}/${parts.length}) ${p}`) : parts;
}

function cleanLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of labels) {
    const name = clip(l.trim(), LIMIT.label);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out.slice(0, LIMIT.labels);
}

interface TaskInput {
  content: string;
  description: string;
  priority: 1 | 2 | 3 | 4;
  due: DueResult;
  dueText: string;
  durationMin: number | null;
  durationText: string;
  deadline: PlainDate | null;
  labels: string[];
  section: string | null;
  responsible: string | null;
}

/** Baut eine Aufgabe so, dass sie garantiert durch die Server-Prüfung kommt. */
function makeTask(t: TaskInput, warnings: string[]): ImportTask {
  let title = t.content.replace(/\s+/g, ' ').trim();
  let description = t.description.replace(/\r\n?/g, '\n').trim();
  if (title.length > LIMIT.title) {
    description = appendNote(description, `Vollständiger Titel aus Todoist:\n${title}`);
    title = clip(title, LIMIT.title);
  }
  if (!t.due.understood && t.dueText) {
    description = appendNote(description, `Fälligkeit in Todoist: ${t.dueText}`);
    warnings.push(`„${clip(title, 60)}“: „${t.dueText}“ nicht verstanden – steht in der Beschreibung`);
  }
  let durationMin = t.durationMin;
  if (durationMin !== null && durationMin > LIMIT.duration) {
    description = appendNote(description, `Dauer in Todoist: ${t.durationText}`);
    durationMin = null;
  }
  if (t.responsible) description = appendNote(description, `In Todoist zuständig: ${t.responsible}`);
  if (description.length > LIMIT.description) description = clip(description, LIMIT.description);
  return {
    title: title || 'Ohne Titel',
    description,
    priority: t.priority,
    dueDate: t.due.dueDate,
    dueTime: t.due.dueDate ? t.due.dueTime : null,
    recurrence: t.due.dueDate ? t.due.recurrence : null,
    durationMin: durationMin && durationMin > 0 ? Math.round(durationMin) : null,
    deadline: t.deadline,
    labels: cleanLabels(t.labels),
    section: t.section,
    comments: [],
    reminders: [],
    children: [],
  };
}

function countTasks(tasks: ImportTask[]): number {
  return tasks.reduce((n, t) => n + 1 + countTasks(t.children), 0);
}

function finish(plan: Omit<ImportPlan, 'taskCount' | 'commentCount' | 'reminderCount'>): ImportPlan {
  let comments = 0;
  let reminders = 0;
  const walk = (tasks: ImportTask[]) => {
    for (const t of tasks) {
      comments += t.comments.length;
      reminders += t.reminders.length;
      walk(t.children);
    }
  };
  for (const p of plan.projects) walk(p.tasks);
  return { ...plan, taskCount: plan.projects.reduce((n, p) => n + countTasks(p.tasks), 0), commentCount: comments, reminderCount: reminders };
}

// ---------- Datumsangaben ----------

export interface DueResult {
  dueDate: PlainDate | null;
  dueTime: PlainTime | null;
  recurrence: Recurrence | null;
  understood: boolean;
}

const NONE: DueResult = { dueDate: null, dueTime: null, recurrence: null, understood: true };

const DE_MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const DE_MONTH_ABBR: Record<string, number> = {
  jan: 0, feb: 1, mär: 2, mrz: 2, mar: 2, apr: 3, mai: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, okt: 9, nov: 10, dez: 11,
};
const MONTH_ALT = DE_MONTHS.join('|');

/** Deutsche Todoist-Schreibweisen in Formen bringen, die der Parser sicher versteht. */
export function normalizeGerman(input: string): string {
  let s = ` ${input.replace(/\s+/g, ' ').trim()} `;
  // Monatsabkürzungen: "25. Nov." → "25. November"
  s = s.replace(/(?<![\p{L}])(jan|feb|mär|mrz|apr|mai|jun|jul|aug|sept|sep|okt|nov|dez)\.?(?![\p{L}])/giu, (_m, a: string) => DE_MONTHS[DE_MONTH_ABBR[a.toLowerCase()]!]!);
  // "25 November" → "25. November", "November 25" → "25. November"
  s = s.replace(new RegExp(`(?<![\\d.])(\\d{1,2})\\s+(${MONTH_ALT})`, 'gu'), '$1. $2');
  s = s.replace(new RegExp(`(${MONTH_ALT})\\s+(\\d{1,2})(?![\\d.:])`, 'gu'), '$2. $1');
  s = s.replace(/ jeden wochentag /giu, ' werktags ');
  s = s.replace(/ jede woche /giu, ' wöchentlich ').replace(/ jeden monat /giu, ' monatlich ');
  return s.trim();
}

const EN_WEEKDAYS: Record<string, string> = {
  mon: 'Montag', monday: 'Montag', tue: 'Dienstag', tues: 'Dienstag', tuesday: 'Dienstag', wed: 'Mittwoch', wednesday: 'Mittwoch',
  thu: 'Donnerstag', thur: 'Donnerstag', thurs: 'Donnerstag', thursday: 'Donnerstag', fri: 'Freitag', friday: 'Freitag',
  sat: 'Samstag', saturday: 'Samstag', sun: 'Sonntag', sunday: 'Sonntag',
};
const EN_MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};
const EN_ORD: Record<string, string> = {
  '1st': 'ersten', first: 'ersten', '2nd': 'zweiten', second: 'zweiten', '3rd': 'dritten', third: 'dritten',
  '4th': 'vierten', fourth: 'vierten', last: 'letzten',
};
const EN_UNIT: Record<string, string> = { day: 'Tage', week: 'Wochen', month: 'Monate', year: 'Jahre' };
const WD = Object.keys(EN_WEEKDAYS).sort((a, b) => b.length - a.length).join('|');
const MO = Object.keys(EN_MONTHS).sort((a, b) => b.length - a.length).join('|');

/** Englische Todoist-Angaben ("every other monday at 9am") ins Deutsche übertragen. */
export function englishToGerman(input: string): string {
  let s = ` ${input.toLowerCase().replace(/\s+/g, ' ').trim()} `;
  const wd = (w: string) => EN_WEEKDAYS[w]!;
  const mo = (m: string) => DE_MONTHS[EN_MONTHS[m]!]!;
  // Startdatum spielt keine Rolle (der nächste Termin kommt aus dem Datum), Anzahl-Begrenzungen gibt es nicht
  s = s.replace(/ (?:starting|from|beginning) (?:on )?.+?(?= until | ending | for |$)/g, ' ').replace(/ for \d+ (?:day|week|month|year|time)s? /g, ' ');
  s = s.replace(/ (?:until|ending) (?:on )?/g, ' bis ');
  // Uhrzeiten
  s = s.replace(/ at noon /g, ' um 12:00 ').replace(/ at midnight /g, ' um 0:00 ');
  s = s.replace(/(\d{1,2})(?::(\d{2}))? ?(am|pm)\b/g, (_m, h: string, mm: string | undefined, ap: string) => `${(Number(h) % 12) + (ap === 'pm' ? 12 : 0)}:${mm ?? '00'}`);
  s = s.replace(/ at (\d{1,2}:\d{2}) /g, ' um $1 ').replace(/ at (\d{1,2}) /g, ' um $1 Uhr ');
  // Wiederholungen
  s = s.replace(/ every other (day|week|month|year) /g, (_m, u: string) => ` alle 2 ${EN_UNIT[u]} `);
  s = s.replace(new RegExp(` every other (${WD}) `, 'g'), (_m, w: string) => ` jeden zweiten ${wd(w)} `);
  s = s.replace(/ every (\d+) (day|week|month|year)s? /g, (_m, n: string, u: string) => ` alle ${n} ${EN_UNIT[u]} `);
  s = s.replace(new RegExp(` every (1st|first|2nd|second|3rd|third|4th|fourth|last) (${WD}) `, 'g'), (_m, o: string, w: string) => ` jeden ${EN_ORD[o]} ${wd(w)} im Monat `);
  s = s.replace(/ every last day /g, ' jeden letzten Tag des Monats ');
  s = s.replace(new RegExp(` every (?:year )?(?:on )?(${MO}) (\\d{1,2})(?:st|nd|rd|th)? `, 'g'), (_m, m: string, d: string) => ` jedes Jahr am ${d}. ${mo(m)} `);
  s = s.replace(new RegExp(` every (?:year )?(?:on )?(?:the )?(\\d{1,2})(?:st|nd|rd|th)? (${MO}) `, 'g'), (_m, d: string, m: string) => ` jedes Jahr am ${d}. ${mo(m)} `);
  s = s.replace(/ every (?:month )?(?:on )?(?:the )?(\d{1,2})(?:st|nd|rd|th)? /g, ' jeden $1. ');
  s = s.replace(/ every (?:weekday|workday) /g, ' werktags ').replace(/ every weekend /g, ' jedes Wochenende ');
  s = s.replace(/ (?:every day|daily) /g, ' täglich ').replace(/ (?:every week|weekly) /g, ' wöchentlich ');
  s = s.replace(/ (?:every month|monthly) /g, ' monatlich ').replace(/ (?:every quarter|quarterly) /g, ' vierteljährlich ');
  s = s.replace(/ (?:every year|yearly|annually) /g, ' jährlich ');
  s = s.replace(/ every /g, ' jeden ');
  // Einzeltermine
  s = s.replace(/ today /g, ' heute ').replace(/ tomorrow /g, ' morgen ').replace(/ next week /g, ' nächste Woche ');
  s = s.replace(new RegExp(` next (${WD}) `, 'g'), (_m, w: string) => ` nächsten ${wd(w)} `);
  s = s.replace(new RegExp(`(?<![\\d.])(\\d{1,2})(?:st|nd|rd|th)? (${MO})(?: (\\d{4}))? `, 'g'), (_m, d: string, m: string, y?: string) => ` ${d}. ${mo(m)}${y ? ` ${y}` : ''} `);
  s = s.replace(new RegExp(` (${MO}) (\\d{1,2})(?:st|nd|rd|th)?,?(?: (\\d{4}))? `, 'g'), (_m, m: string, d: string, y?: string) => ` ${d}. ${mo(m)}${y ? ` ${y}` : ''} `);
  s = s.replace(new RegExp(`(?<![\\p{L}])(${WD})(?![\\p{L}])`, 'gu'), (w) => wd(w));
  s = s.replace(/ and /g, ' und ').replace(/ on /g, ' am ');
  return s.replace(/\s+/g, ' ').trim();
}

/** Todoist-Datumstext (deutsch oder englisch, ISO oder natürliche Sprache) verstehen. */
export function convertDate(raw: string, lang: string, ctx: Pick<ImportContext, 'today' | 'now'>): DueResult {
  const text = raw.trim();
  if (!text) return NONE;
  const iso = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(text);
  if (iso && !/[a-z]{3,}/i.test(text.slice(iso[0].length))) {
    return { dueDate: iso[1]!, dueTime: iso[2] ? `${iso[2]}:${iso[3]}` : null, recurrence: null, understood: true };
  }
  // "every! 3 days" / "alle! 3 Tage": Wiederholung ab Erledigung
  const afterCompletion = /^\s*\S+!/.test(text) || /nach erledigung/i.test(text);
  const plain = text.replace(/^(\s*\S+)!/, '$1');
  let german = lang.toLowerCase().startsWith('de') ? normalizeGerman(plain) : normalizeGerman(englishToGerman(plain));
  if (afterCompletion && !/erledigung/i.test(german)) german += ' nach Erledigung';
  const r = parseTask(`${german} x`, ctx);
  const understood = r.title.trim().toLowerCase() === 'x' && (!!r.dueDate || !!r.recurrence);
  if (!understood) return { ...NONE, understood: false };
  return { dueDate: r.dueDate, dueTime: r.dueTime, recurrence: r.recurrence, understood: true };
}

// ---------- CSV (Backup oder Export) ----------

/** CSV nach RFC 4180 (Anführungszeichen, Kommas und Zeilenumbrüche in Feldern). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

function projectNameFromFile(file: string): string {
  return (
    file
      .split('/')
      .pop()!
      .replace(/\.csv$/i, '')
      .replace(/\s*\[\d+\]$/, '')
      .replace(/_/g, ' ')
      .trim() || 'Import'
  );
}

/** "Anna (12345)" → "Anna" */
function personName(raw: string): string | null {
  const name = raw.replace(/\s*\(\d+\)\s*$/, '').trim();
  return name || null;
}

/** Labels stehen in Todoist-CSVs als "@name" im Titel. */
function splitLabels(content: string): { title: string; labels: string[] } {
  const labels = [...content.matchAll(/(?:^|\s)@([^\s@]+)/gu)].map((m) => m[1]!.replace(/[.,;:!?)]+$/, ''));
  const title = content.replace(/(?:^|\s)@[^\s@]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return { title: title || content.trim(), labels };
}

export function planFromCsv(files: { name: string; text: string }[], ctx: ImportContext): ImportPlan {
  const warnings: string[] = [];
  const projects: ImportProject[] = [];
  const labelNames = new Set<string>();

  for (const file of files) {
    const rows = parseCsv(file.text);
    const header = rows.shift()?.map((h) => h.trim().toUpperCase());
    if (!header?.includes('TYPE') || !header.includes('CONTENT')) {
      warnings.push(`${file.name}: keine Todoist-CSV-Datei`);
      continue;
    }
    const col = (row: string[], name: string) => row[header.indexOf(name)]?.trim() ?? '';
    const name = clip(projectNameFromFile(file.name), LIMIT.name);
    const project: ImportProject = {
      key: `csv:${file.name}`,
      name,
      isInbox: /^(inbox|eingang)$/i.test(name),
      parentKey: null,
      color: null,
      archived: false,
      sections: [],
      tasks: [],
    };
    let section: string | null = null;
    const stack: ImportTask[] = [];
    let last: ImportTask | null = null;
    const projectNotes: ImportComment[] = [];

    for (const row of rows) {
      const type = col(row, 'TYPE').toLowerCase();
      const content = col(row, 'CONTENT');
      if (type === 'section') {
        const sName = clip(content.replace(/\s+/g, ' '), LIMIT.name);
        section = sName || null;
        if (section && !project.sections.some((s) => s.key === section)) project.sections.push({ key: section, name: section });
        stack.length = 0;
        last = null;
        continue;
      }
      if (type === 'note') {
        const target = last ? last.comments : projectNotes;
        for (const body of splitComment(content)) target.push({ body, at: null });
        continue;
      }
      if (type !== 'task' || !content) continue;

      const { title, labels } = splitLabels(content);
      labels.forEach((l) => labelNames.add(l));
      const dueText = col(row, 'DATE');
      const deadlineText = col(row, 'DEADLINE');
      const deadline = deadlineText ? convertDate(deadlineText, col(row, 'DEADLINE_LANG') || col(row, 'DATE_LANG') || 'en', ctx).dueDate : null;
      const prio = Number(col(row, 'PRIORITY'));
      const dur = Number(col(row, 'DURATION'));
      const unit = col(row, 'DURATION_UNIT').toLowerCase();
      const responsible = personName(col(row, 'RESPONSIBLE'));
      const task = makeTask(
        {
          content: title,
          description: col(row, 'DESCRIPTION') + (deadlineText && !deadline ? `\n\nDeadline in Todoist: ${deadlineText}` : ''),
          // In Todoist-CSVs ist 1 die höchste Priorität (p1), 4 die normale
          priority: prio >= 1 && prio <= 4 ? (Math.round(prio) as 1 | 2 | 3 | 4) : 4,
          due: convertDate(dueText, col(row, 'DATE_LANG') || 'en', ctx),
          dueText,
          durationMin: dur > 0 ? (unit.startsWith('day') ? dur * 1440 : dur) : null,
          durationText: `${dur} ${unit || 'minute'}`,
          deadline,
          labels,
          section,
          responsible,
        },
        warnings,
      );
      const indent = Math.max(1, Math.round(Number(col(row, 'INDENT'))) || 1);
      // nächste übergeordnete Aufgabe suchen (auch wenn eine Ebene übersprungen wurde)
      let parent: ImportTask | undefined;
      for (let i = Math.min(indent - 2, stack.length - 1); i >= 0 && !parent; i--) parent = stack[i];
      if (parent) parent.children.push(task);
      else project.tasks.push(task);
      stack.length = Math.min(stack.length, indent - 1);
      stack[indent - 1] = task;
      last = task;
    }
    if (projectNotes.length) project.tasks.unshift(notesTask(projectNotes));
    projects.push(project);
  }
  return finish({ source: 'csv', projects, labels: [...labelNames].map((name) => ({ name, color: null })), warnings });
}

function notesTask(comments: ImportComment[]): ImportTask {
  return {
    title: NOTES_TITLE,
    description: 'Kommentare, die in Todoist am Projekt hingen.',
    priority: 4,
    dueDate: null,
    dueTime: null,
    recurrence: null,
    durationMin: null,
    deadline: null,
    labels: [],
    section: null,
    comments,
    reminders: [],
    children: [],
  };
}

/** Ausgewählte Dateien lesen: CSV direkt, ZIP-Backups werden entpackt. */
export async function readImportFiles(files: File[]): Promise<{ name: string; text: string }[]> {
  const out: { name: string; text: string }[] = [];
  const utf8 = new TextDecoder();
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (isZip(bytes)) {
      for (const e of await unzip(bytes)) {
        if (/\.csv$/i.test(e.name) && !e.name.split('/').pop()!.startsWith('.')) out.push({ name: e.name, text: utf8.decode(e.bytes) });
      }
    } else out.push({ name: f.name, text: utf8.decode(bytes) });
  }
  return out;
}

// ---------- API (vollständiger Abzug) ----------

interface TdDue {
  date: string;
  timezone?: string | null;
  string?: string;
  lang?: string;
  is_recurring?: boolean;
}
interface TdProject {
  id: string;
  name: string;
  color?: string;
  parent_id?: string | null;
  child_order?: number;
  inbox_project?: boolean;
  is_archived?: boolean;
  is_deleted?: boolean;
}
interface TdSection {
  id: string;
  name: string;
  project_id: string;
  section_order?: number;
  is_deleted?: boolean;
}
interface TdItem {
  id: string;
  content: string;
  description?: string;
  project_id: string;
  section_id?: string | null;
  parent_id?: string | null;
  child_order?: number;
  priority?: number;
  due?: TdDue | null;
  deadline?: { date: string } | null;
  duration?: { amount: number; unit: string } | null;
  labels?: string[];
  checked?: boolean;
  is_deleted?: boolean;
  responsible_uid?: string | null;
}
interface TdNote {
  id: string;
  item_id?: string;
  project_id?: string;
  content?: string;
  posted_at?: string;
  posted_uid?: string;
  file_attachment?: { file_name?: string; file_url?: string; url?: string; title?: string } | null;
  is_deleted?: boolean;
}
interface TdReminder {
  id: string;
  item_id: string;
  type: string;
  due?: TdDue | null;
  minute_offset?: number | null;
  is_deleted?: boolean;
}
interface TdLabel {
  name: string;
  color?: string;
  item_order?: number;
  is_deleted?: boolean;
}

export interface TodoistData {
  projects?: TdProject[];
  items?: TdItem[];
  sections?: TdSection[];
  labels?: TdLabel[];
  notes?: TdNote[];
  project_notes?: TdNote[];
  reminders?: TdReminder[];
  collaborators?: { id: string; full_name?: string; email?: string }[];
  user?: { id: string; full_name?: string };
}

/** Todoist-Farbnamen → Farbwerte */
const TODOIST_COLORS: Record<string, string> = {
  berry_red: '#b8256f', red: '#db4035', orange: '#ff9933', yellow: '#fad000', olive_green: '#afb83b', lime_green: '#7ecc49',
  green: '#299438', mint_green: '#6accbc', teal: '#158fad', sky_blue: '#14aaf5', light_blue: '#96c3eb', blue: '#4073ff',
  grape: '#884dff', violet: '#af38eb', lavender: '#eb96eb', magenta: '#e05194', salmon: '#ff8d85', charcoal: '#808080',
  grey: '#b8b8b8', gray: '#b8b8b8', taupe: '#ccac93',
};

const RESOURCES = ['projects', 'items', 'sections', 'labels', 'notes', 'project_notes', 'reminders', 'collaborators', 'user'];

/** Vollständiger Abzug über die Todoist-Sync-Schnittstelle. Der Schlüssel verlässt den Browser nur Richtung Todoist. */
export async function fetchTodoist(token: string): Promise<TodoistData> {
  let res: Response;
  try {
    res = await fetch('https://api.todoist.com/api/v1/sync', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.trim()}` },
      body: new URLSearchParams({ sync_token: '*', resource_types: JSON.stringify(RESOURCES) }),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new Error('Todoist ist gerade nicht erreichbar. Bitte Internetverbindung prüfen.');
  }
  if (res.status === 401 || res.status === 403) throw new Error('Der API-Schlüssel stimmt nicht. Bitte in Todoist neu kopieren.');
  if (res.status === 429) throw new Error('Todoist bremst gerade (zu viele Anfragen). Bitte in ein paar Minuten noch einmal.');
  if (!res.ok) throw new Error(`Todoist antwortet mit Fehler ${res.status}.`);
  return (await res.json()) as TodoistData;
}

/** Datum aus der API: ganztägig, "schwebend" (lokale Uhrzeit) oder UTC mit fester Zeitzone. */
function apiDate(date: string, ctx: ImportContext): { date: PlainDate; time: PlainTime | null } | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z)?)?$/.exec(date.trim());
  if (!m) return null;
  if (!m[2]) return { date: m[1]!, time: null };
  if (m[4]) {
    const local = zonedParts(new Date(date), ctx.timeZone);
    return { date: local.date, time: local.time };
  }
  return { date: m[1]!, time: `${m[2]}:${m[3]}` };
}

function apiDue(due: TdDue | null | undefined, ctx: ImportContext): { due: DueResult; text: string } {
  if (!due?.date) return { due: NONE, text: '' };
  const at = apiDate(due.date, ctx);
  if (!at) {
    const parsed = convertDate(due.string ?? '', due.lang ?? 'en', ctx);
    return { due: parsed, text: due.string ?? due.date };
  }
  if (!due.is_recurring) return { due: { dueDate: at.date, dueTime: at.time, recurrence: null, understood: true }, text: '' };
  const rule = convertDate(due.string ?? '', due.lang ?? 'en', ctx);
  if (rule.recurrence) return { due: { dueDate: at.date, dueTime: at.time, recurrence: rule.recurrence, understood: true }, text: '' };
  // Wiederholung unbekannt: nächster Termin bleibt, Regel steht in der Beschreibung
  return { due: { dueDate: at.date, dueTime: at.time, recurrence: null, understood: false }, text: `${due.string ?? ''} (Wiederholung)`.trim() };
}

function attachmentLine(a: TdNote['file_attachment']): string {
  if (!a) return '';
  const url = a.file_url ?? a.url ?? '';
  const name = a.file_name ?? a.title ?? 'Anhang';
  return url ? `Anhang: [${name}](${url})` : `Anhang: ${name}`;
}

export function planFromApi(data: TodoistData, ctx: ImportContext): ImportPlan {
  const warnings: string[] = [];
  const me = data.user?.id ?? null;
  const people = new Map((data.collaborators ?? []).map((c) => [c.id, c.full_name || c.email || 'jemand']));
  const byOrder = <T,>(key: (x: T) => number | undefined) => (a: T, b: T) => (key(a) ?? 0) - (key(b) ?? 0);

  // Projekte: Eltern vor Kindern, jeweils in Todoist-Reihenfolge
  const allProjects = (data.projects ?? []).filter((p) => !p.is_deleted);
  const projectIds = new Set(allProjects.map((p) => p.id));
  const childrenOf = new Map<string | null, TdProject[]>();
  for (const p of allProjects) {
    const parent = p.parent_id && projectIds.has(p.parent_id) ? p.parent_id : null;
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), p]);
  }
  const ordered: TdProject[] = [];
  const visit = (parent: string | null) => {
    for (const p of (childrenOf.get(parent) ?? []).sort(byOrder((x) => (x.inbox_project ? -1 : x.child_order)))) {
      ordered.push(p);
      visit(p.id);
    }
  };
  visit(null);

  // Kommentare und Erinnerungen je Aufgabe
  const notesByItem = new Map<string, TdNote[]>();
  for (const n of data.notes ?? []) {
    if (n.is_deleted || !n.item_id) continue;
    notesByItem.set(n.item_id, [...(notesByItem.get(n.item_id) ?? []), n]);
  }
  const notesByProject = new Map<string, TdNote[]>();
  for (const n of data.project_notes ?? []) {
    if (n.is_deleted || !n.project_id) continue;
    notesByProject.set(n.project_id, [...(notesByProject.get(n.project_id) ?? []), n]);
  }
  const remindersByItem = new Map<string, TdReminder[]>();
  let locationReminders = 0;
  for (const r of data.reminders ?? []) {
    if (r.is_deleted) continue;
    if (r.type === 'location') {
      locationReminders++;
      continue;
    }
    remindersByItem.set(r.item_id, [...(remindersByItem.get(r.item_id) ?? []), r]);
  }
  const toComments = (notes: TdNote[]): ImportComment[] =>
    notes
      .sort((a, b) => (a.posted_at ?? '').localeCompare(b.posted_at ?? ''))
      .flatMap((n) => {
        const who = n.posted_uid && n.posted_uid !== me ? people.get(n.posted_uid) : null;
        const text = [n.content?.trim() ?? '', attachmentLine(n.file_attachment)].filter(Boolean).join('\n');
        return splitComment(who ? `${who}: ${text}` : text).map((body) => ({ body, at: n.posted_at ?? null }));
      });

  // Aufgaben: nur offene, nicht gelöschte
  const items = (data.items ?? []).filter((i) => !i.is_deleted && !i.checked && i.content?.trim());
  const labelNames = new Set<string>();

  const toTask = (i: TdItem, sectionKey: string | null): ImportTask => {
    const { due, text } = apiDue(i.due, ctx);
    const unit = i.duration?.unit ?? 'minute';
    const amount = i.duration?.amount ?? 0;
    const responsible = i.responsible_uid && i.responsible_uid !== me ? (people.get(i.responsible_uid) ?? null) : null;
    (i.labels ?? []).forEach((l) => labelNames.add(l));
    const task = makeTask(
      {
        content: i.content,
        description: i.description ?? '',
        // API: 4 = dringend (p1), 1 = normal
        priority: (5 - Math.min(4, Math.max(1, i.priority ?? 1))) as 1 | 2 | 3 | 4,
        due,
        dueText: text,
        durationMin: amount > 0 ? (unit === 'day' ? amount * 1440 : amount) : null,
        durationText: `${amount} ${unit === 'day' ? 'Tage' : 'Minuten'}`,
        deadline: i.deadline?.date && /^\d{4}-\d{2}-\d{2}$/.test(i.deadline.date) ? i.deadline.date : null,
        labels: i.labels ?? [],
        section: sectionKey,
        responsible,
      },
      warnings,
    );
    task.comments = toComments(notesByItem.get(i.id) ?? []);
    for (const r of remindersByItem.get(i.id) ?? []) {
      if (r.type === 'relative' && typeof r.minute_offset === 'number' && r.minute_offset >= 0) {
        task.reminders.push({ kind: 'relative', offsetMin: Math.min(525600, Math.round(r.minute_offset)) });
      } else if (r.due?.date) {
        const at = apiDate(r.due.date, ctx);
        if (at?.time) task.reminders.push({ kind: 'absolute', date: at.date, time: at.time });
      }
    }
    return task;
  };

  const projects: ImportProject[] = [];
  for (const p of ordered) {
    const sections = (data.sections ?? []).filter((s) => s.project_id === p.id && !s.is_deleted).sort(byOrder((s) => s.section_order));
    const sectionKeys = new Set(sections.map((s) => s.id));
    const own = items.filter((i) => i.project_id === p.id);
    const ownIds = new Set(own.map((i) => i.id));
    const kids = new Map<string, TdItem[]>();
    const top: TdItem[] = [];
    for (const i of own) {
      const parent = i.parent_id && ownIds.has(i.parent_id) ? i.parent_id : null;
      if (parent) kids.set(parent, [...(kids.get(parent) ?? []), i]);
      else top.push(i);
    }
    const build = (i: TdItem, sectionKey: string | null): ImportTask => {
      const t = toTask(i, sectionKey);
      t.children = (kids.get(i.id) ?? []).sort(byOrder((x) => x.child_order)).map((c) => build(c, sectionKey));
      return t;
    };
    const sectionIndex = new Map(sections.map((s, i) => [s.id, i]));
    const tasks = top
      .sort((a, b) => (sectionIndex.get(a.section_id ?? '') ?? -1) - (sectionIndex.get(b.section_id ?? '') ?? -1) || (a.child_order ?? 0) - (b.child_order ?? 0))
      .map((i) => build(i, i.section_id && sectionKeys.has(i.section_id) ? i.section_id : null));
    const pNotes = toComments(notesByProject.get(p.id) ?? []);
    if (pNotes.length) tasks.unshift(notesTask(pNotes));
    projects.push({
      key: p.id,
      name: clip(p.name.trim() || 'Ohne Namen', LIMIT.name),
      isInbox: !!p.inbox_project,
      parentKey: p.parent_id && projectIds.has(p.parent_id) ? p.parent_id : null,
      color: (p.color && TODOIST_COLORS[p.color]) ?? null,
      archived: !!p.is_archived,
      sections: sections.map((s) => ({ key: s.id, name: clip(s.name.trim() || 'Abschnitt', LIMIT.name) })),
      tasks,
    });
  }

  const orphans = items.filter((i) => !projectIds.has(i.project_id)).length;
  if (orphans) warnings.push(`${orphans} Aufgaben gehören zu Projekten, die Todoist nicht mitgeschickt hat (z. B. Team-Projekte)`);
  if (locationReminders) warnings.push(`${locationReminders} Orts-Erinnerungen gibt es in Do-it nicht – nicht übernommen`);

  const labels = new Map<string, string | null>();
  for (const l of (data.labels ?? []).filter((x) => !x.is_deleted).sort(byOrder((x) => x.item_order))) {
    labels.set(l.name, (l.color && TODOIST_COLORS[l.color]) ?? null);
  }
  for (const l of labelNames) if (!labels.has(l)) labels.set(l, null);
  return finish({
    source: 'api',
    projects,
    labels: [...labels].map(([name, color]) => ({ name: clip(name.trim(), LIMIT.label), color })).filter((l) => l.name),
    warnings,
  });
}

// ---------- Übernehmen ----------

export type ImportMutation = { type: 'project' | 'section' | 'task' | 'comment' | 'label' | 'reminder'; id: string; data: Record<string, unknown> };

export interface ImportTarget {
  me: Me;
  inboxId: string;
  existingProjects: { id: string; name: string; parentId: string | null; sortKey: string }[];
  existingSections: { id: string; projectId: string; name: string; sortKey: string }[];
  existingTasks: { id: string; projectId: string; parentId: string | null; title: string; dueDate: string | null; sortKey: string }[];
  existingLabels: string[];
}

export interface ImportResult {
  mutations: ImportMutation[];
  tasks: number;
  /** schon vorhandene Aufgaben (gleicher Titel, gleiches Datum, gleicher Ort), z. B. bei doppeltem Import */
  skipped: number;
  projects: number;
}

const IMPORT_COLORS = ['#3e63dd', '#e5484d', '#f76b15', '#8e4ec6', '#12a594', '#d6409f', '#978365', '#0f8b6c'];
const maxKey = (keys: string[]) => keys.reduce<string | null>((m, k) => (m === null || k > m ? k : m), null);

/**
 * Wandelt den Plan in Änderungen um. Gleichnamige Projekte und Abschnitte werden ergänzt,
 * schon vorhandene Aufgaben übersprungen – ein zweiter Import legt also nichts doppelt an.
 */
export function buildImport(plan: ImportPlan, t: ImportTarget): ImportResult {
  const out: ImportMutation[] = [];
  const now = new Date().toISOString();
  let tasks = 0;
  let skipped = 0;
  let newProjects = 0;

  const labels = new Set(t.existingLabels.map((l) => l.toLowerCase()));
  for (const l of plan.labels) {
    if (labels.has(l.name.toLowerCase())) continue;
    labels.add(l.name.toLowerCase());
    out.push({ type: 'label', id: uuidv7(), data: { name: l.name, color: l.color } });
  }

  const projectIdByKey = new Map<string, string>();
  const knownProjects = [...t.existingProjects];
  const lastKey = new Map<string | null, string | null>();
  const nextSortKey = (parentId: string | null) => {
    if (!lastKey.has(parentId)) lastKey.set(parentId, maxKey(knownProjects.filter((p) => p.parentId === parentId).map((p) => p.sortKey)));
    const key = generateNKeysBetween(lastKey.get(parentId) ?? null, null, 1)[0]!;
    lastKey.set(parentId, key);
    return key;
  };

  const taskIndex = new Map<string, { id: string; sortKey: string }>();
  const taskKey = (projectId: string, parentId: string | null, title: string, due: string | null) => `${projectId}|${parentId ?? ''}|${title.trim().toLowerCase()}|${due ?? ''}`;
  for (const e of t.existingTasks) taskIndex.set(taskKey(e.projectId, e.parentId, e.title, e.dueDate), { id: e.id, sortKey: e.sortKey });

  for (const [pi, p] of plan.projects.entries()) {
    const parentId = p.parentKey ? (projectIdByKey.get(p.parentKey) ?? null) : null;
    let projectId = p.isInbox ? t.inboxId : knownProjects.find((e) => e.parentId === parentId && e.name.toLowerCase() === p.name.toLowerCase())?.id;
    if (!projectId) {
      projectId = uuidv7();
      const sortKey = nextSortKey(parentId);
      out.push({
        type: 'project',
        id: projectId,
        data: { name: p.name, sortKey, color: p.color ?? IMPORT_COLORS[pi % IMPORT_COLORS.length]!, parentId, archived: p.archived },
      });
      knownProjects.push({ id: projectId, name: p.name, parentId, sortKey });
      newProjects++;
    }
    projectIdByKey.set(p.key, projectId);

    const sectionIds = new Map<string, string>();
    const existingSections = t.existingSections.filter((s) => s.projectId === projectId);
    const newSections = p.sections.filter((s) => {
      const found = existingSections.find((e) => e.name.toLowerCase() === s.name.toLowerCase());
      if (found) sectionIds.set(s.key, found.id);
      return !found;
    });
    const sectionKeys = generateNKeysBetween(maxKey(existingSections.map((s) => s.sortKey)), null, newSections.length);
    newSections.forEach((s, i) => {
      const id = uuidv7();
      sectionIds.set(s.key, id);
      out.push({ type: 'section', id, data: { projectId, name: s.name, sortKey: sectionKeys[i]! } });
    });

    const add = (list: ImportTask[], parentId: string | null) => {
      const fresh: { task: ImportTask; existing?: string }[] = list.map((task) => {
        const hit = taskIndex.get(taskKey(projectId, parentId, task.title, task.dueDate));
        return { task, existing: hit?.id };
      });
      const siblingsMax = maxKey([...taskIndex.entries()].filter(([k]) => k.startsWith(`${projectId}|${parentId ?? ''}|`)).map(([, v]) => v.sortKey));
      const keys = generateNKeysBetween(siblingsMax, null, fresh.filter((f) => !f.existing).length);
      let k = 0;
      for (const { task, existing } of fresh) {
        if (existing) {
          skipped += 1;
          add(task.children, existing);
          continue;
        }
        const id = uuidv7();
        const sortKey = keys[k++]!;
        taskIndex.set(taskKey(projectId, parentId, task.title, task.dueDate), { id, sortKey });
        out.push({
          type: 'task',
          id,
          data: {
            projectId,
            sectionId: task.section ? (sectionIds.get(task.section) ?? null) : null,
            parentId,
            title: task.title,
            description: task.description,
            priority: task.priority,
            dueDate: task.dueDate,
            dueTime: task.dueDate ? task.dueTime : null,
            recurrence: task.dueDate ? task.recurrence : null,
            durationMin: task.durationMin,
            deadline: task.deadline,
            labels: task.labels,
            sortKey,
            createdBy: t.me.id,
            createdAt: now,
          },
        });
        tasks++;
        for (const c of task.comments) {
          out.push({ type: 'comment', id: uuidv7(), data: { taskId: id, body: c.body, authorId: t.me.id, createdAt: c.at ?? now } });
        }
        for (const r of task.reminders) {
          out.push({
            type: 'reminder',
            id: uuidv7(),
            data:
              r.kind === 'relative'
                ? { taskId: id, kind: 'relative', offsetMin: r.offsetMin, date: null, time: null }
                : { taskId: id, kind: 'absolute', offsetMin: null, date: r.date, time: r.time },
          });
        }
        add(task.children, id);
      }
    };
    add(p.tasks, null);
  }
  return { mutations: out, tasks, skipped, projects: newProjects };
}
