import { parseTask } from '@do-it/parser';
import { generateNKeysBetween, uuidv7, type Me, type PlainDate, type PlainTime, type Recurrence } from '@do-it/shared';

/**
 * Import aus Todoist: CSV-Dateien aus "Einstellungen → Backups" (eine Datei pro Projekt).
 * Spalten: TYPE, CONTENT, DESCRIPTION, PRIORITY, INDENT, AUTHOR, RESPONSIBLE, DATE, DATE_LANG, TIMEZONE, DURATION, DURATION_UNIT, DEADLINE …
 */

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
  section: string | null;
  comments: string[];
  children: ImportTask[];
}

export interface ImportProject {
  name: string;
  isInbox: boolean;
  sections: string[];
  tasks: ImportTask[];
}

export interface ImportPlan {
  projects: ImportProject[];
  taskCount: number;
  commentCount: number;
  warnings: string[];
}

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

const EN_DE: [RegExp, string][] = [
  [/\bevery!\s*/gi, 'every '],
  [/\bevery (other|2nd) /gi, 'alle 2 '],
  [/\bevery (\d+) days?\b/gi, 'alle $1 Tage'],
  [/\bevery (\d+) weeks?\b/gi, 'alle $1 Wochen'],
  [/\bevery (\d+) months?\b/gi, 'alle $1 Monate'],
  [/\bevery (\d+) years?\b/gi, 'alle $1 Jahre'],
  [/\b(every day|daily)\b/gi, 'täglich'],
  [/\b(every weekday|every workday)\b/gi, 'werktags'],
  [/\b(every week|weekly)\b/gi, 'wöchentlich'],
  [/\b(every month|monthly)\b/gi, 'monatlich'],
  [/\b(every year|yearly|annually)\b/gi, 'jährlich'],
  [/\bevery\b/gi, 'jeden'],
  [/\b(days)\b/gi, 'Tage'],
  [/\b(weeks)\b/gi, 'Wochen'],
  [/\b(months)\b/gi, 'Monate'],
  [/\bmon(day)?\b/gi, 'Montag'],
  [/\btue(s|sday)?\b/gi, 'Dienstag'],
  [/\bwed(nesday)?\b/gi, 'Mittwoch'],
  [/\bthu(rs|rsday)?\b/gi, 'Donnerstag'],
  [/\bfri(day)?\b/gi, 'Freitag'],
  [/\bsat(urday)?\b/gi, 'Samstag'],
  [/\bsun(day)?\b/gi, 'Sonntag'],
  [/\btoday\b/gi, 'heute'],
  [/\btomorrow\b/gi, 'morgen'],
  [/\bat (\d)/gi, 'um $1'],
  [/\b(\d{1,2})(?::(\d{2}))?\s*pm\b/gi, (_m: string, h: string, mm?: string) => `${(Number(h) % 12) + 12}:${mm ?? '00'}`] as unknown as [RegExp, string],
  [/\b(\d{1,2})(?::(\d{2}))?\s*am\b/gi, (_m: string, h: string, mm?: string) => `${Number(h) % 12}:${mm ?? '00'}`] as unknown as [RegExp, string],
  [/\bjan(uary)?\b/gi, 'Januar'],
  [/\bfeb(ruary)?\b/gi, 'Februar'],
  [/\bmar(ch)?\b/gi, 'März'],
  [/\bapr(il)?\b/gi, 'April'],
  [/\bmay\b/gi, 'Mai'],
  [/\bjun(e)?\b/gi, 'Juni'],
  [/\bjul(y)?\b/gi, 'Juli'],
  [/\baug(ust)?\b/gi, 'August'],
  [/\bsep(t|tember)?\b/gi, 'September'],
  [/\boct(ober)?\b/gi, 'Oktober'],
  [/\bnov(ember)?\b/gi, 'November'],
  [/\bdec(ember)?\b/gi, 'Dezember'],
];

function englishToGerman(s: string): string {
  let out = s;
  for (const [re, rep] of EN_DE) out = out.replace(re, rep as never);
  // "Dezember 24" → "24. Dezember"
  return out.replace(/\b(Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember) (\d{1,2})\b/g, '$2. $1');
}

interface DateResult {
  dueDate: PlainDate | null;
  dueTime: PlainTime | null;
  recurrence: Recurrence | null;
  understood: boolean;
}

/** Todoist-Datumstext (deutsch oder englisch, ISO oder natürliche Sprache) verstehen. */
export function convertDate(raw: string, lang: string, ctx: { today: PlainDate; now: PlainTime }): DateResult {
  const text = raw.trim();
  if (!text) return { dueDate: null, dueTime: null, recurrence: null, understood: true };
  const iso = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(text);
  if (iso) return { dueDate: iso[1]!, dueTime: iso[2] ? `${iso[2]}:${iso[3]}` : null, recurrence: null, understood: true };
  const afterCompletion = /every!/i.test(text) || /nach erledigung/i.test(text);
  const german = lang.toLowerCase().startsWith('de') ? text : englishToGerman(text);
  const r = parseTask(`${german}${afterCompletion && !/erledigung/i.test(german) ? ' nach Erledigung' : ''} x`, ctx);
  const understood = r.title.trim().toLowerCase() === 'x' && (!!r.dueDate || !!r.recurrence);
  return { dueDate: r.dueDate, dueTime: r.dueTime, recurrence: r.recurrence, understood };
}

function projectNameFromFile(file: string): string {
  return file
    .replace(/\.csv$/i, '')
    .replace(/\s*\[\d+\]$/, '')
    .replace(/_/g, ' ')
    .trim();
}

export function planTodoistImport(files: { name: string; text: string }[], ctx: { today: PlainDate; now: PlainTime }): ImportPlan {
  const plan: ImportPlan = { projects: [], taskCount: 0, commentCount: 0, warnings: [] };
  for (const file of files) {
    const rows = parseCsv(file.text);
    const header = rows.shift()?.map((h) => h.trim().toUpperCase());
    if (!header?.includes('TYPE') || !header.includes('CONTENT')) {
      plan.warnings.push(`${file.name}: keine Todoist-CSV-Datei`);
      continue;
    }
    const col = (row: string[], name: string) => row[header.indexOf(name)]?.trim() ?? '';
    const name = projectNameFromFile(file.name);
    const project: ImportProject = { name, isInbox: /^(inbox|eingang)$/i.test(name), sections: [], tasks: [] };
    let section: string | null = null;
    const stack: ImportTask[] = [];
    let last: ImportTask | null = null;

    for (const row of rows) {
      const type = col(row, 'TYPE').toLowerCase();
      const content = col(row, 'CONTENT');
      if (type === 'section') {
        section = content || null;
        if (section && !project.sections.includes(section)) project.sections.push(section);
        stack.length = 0;
        continue;
      }
      if (type === 'note') {
        if (last && content) {
          last.comments.push(content);
          plan.commentCount++;
        }
        continue;
      }
      if (type !== 'task' || !content) continue;

      const labels = [...content.matchAll(/(?:^|\s)@([\p{L}\p{N}_-]+)/gu)].map((m) => m[1]!);
      const title = content.replace(/(?:^|\s)@[\p{L}\p{N}_-]+/gu, '').trim() || content;
      const date = convertDate(col(row, 'DATE'), col(row, 'DATE_LANG') || 'en', ctx);
      const deadline = /^\d{4}-\d{2}-\d{2}/.exec(col(row, 'DEADLINE'))?.[0] ?? null;
      const prio = Number(col(row, 'PRIORITY')) || 1;
      const dur = Number(col(row, 'DURATION'));
      const unit = col(row, 'DURATION_UNIT').toLowerCase();
      let description = col(row, 'DESCRIPTION');
      if (!date.understood) {
        description = `${description ? `${description}\n\n` : ''}Todoist-Datum: ${col(row, 'DATE')}`;
        plan.warnings.push(`„${title}“: Datum „${col(row, 'DATE')}“ nicht verstanden – steht in der Beschreibung`);
      }
      const task: ImportTask = {
        title: title.slice(0, 500),
        description,
        priority: (Math.min(4, Math.max(1, 5 - prio)) as 1 | 2 | 3 | 4),
        dueDate: date.dueDate,
        dueTime: date.dueTime,
        recurrence: date.recurrence,
        durationMin: dur > 0 ? Math.round(unit.startsWith('day') ? dur * 1440 : dur) : null,
        deadline,
        labels,
        section,
        comments: [],
        children: [],
      };
      const indent = Math.max(1, Number(col(row, 'INDENT')) || 1);
      stack.length = Math.min(stack.length, indent - 1);
      const parent = stack[stack.length - 1];
      if (parent && indent > 1) parent.children.push(task);
      else project.tasks.push(task);
      stack[indent - 1] = task;
      last = task;
      plan.taskCount++;
    }
    plan.projects.push(project);
  }
  return plan;
}

export interface ImportTarget {
  me: Me;
  inboxId: string;
  existingProjects: { id: string; name: string }[];
  mutate: (type: 'project' | 'section' | 'task' | 'comment' | 'label', id: string, data: Record<string, unknown>) => Promise<void>;
  existingLabels: string[];
  onProgress?: (done: number, total: number) => void;
}

const IMPORT_COLORS = ['#3e63dd', '#e5484d', '#f76b15', '#8e4ec6', '#12a594', '#d6409f', '#978365', '#0f8b6c'];

/** Plan anlegen: Projekte (gleichnamige werden wiederverwendet), Abschnitte, Aufgaben, Unteraufgaben, Kommentare. */
export async function applyImport(plan: ImportPlan, t: ImportTarget): Promise<void> {
  let done = 0;
  const labels = new Set(t.existingLabels.map((l) => l.toLowerCase()));
  const projectKeys = generateNKeysBetween('a0', null, plan.projects.length);
  for (const [pi, p] of plan.projects.entries()) {
    let projectId = p.isInbox ? t.inboxId : t.existingProjects.find((e) => e.name.toLowerCase() === p.name.toLowerCase())?.id;
    if (!projectId) {
      projectId = uuidv7();
      await t.mutate('project', projectId, { name: p.name, sortKey: projectKeys[pi]!, color: IMPORT_COLORS[pi % IMPORT_COLORS.length]! });
    }
    const sectionIds = new Map<string, string>();
    const sectionKeys = generateNKeysBetween(null, null, p.sections.length);
    for (const [si, s] of p.sections.entries()) {
      const id = uuidv7();
      sectionIds.set(s, id);
      await t.mutate('section', id, { projectId, name: s, sortKey: sectionKeys[si]! });
    }
    const addTasks = async (tasks: ImportTask[], parentId: string | null) => {
      const keys = generateNKeysBetween(null, null, tasks.length);
      for (const [i, task] of tasks.entries()) {
        for (const l of task.labels) {
          if (!labels.has(l.toLowerCase())) {
            labels.add(l.toLowerCase());
            await t.mutate('label', uuidv7(), { name: l, color: null });
          }
        }
        const id = uuidv7();
        await t.mutate('task', id, {
          projectId,
          sectionId: task.section ? (sectionIds.get(task.section) ?? null) : null,
          parentId,
          title: task.title,
          description: task.description,
          priority: task.priority,
          dueDate: task.dueDate,
          dueTime: task.dueDate ? task.dueTime : null,
          recurrence: task.recurrence,
          durationMin: task.durationMin,
          deadline: task.deadline,
          labels: task.labels,
          sortKey: keys[i]!,
          createdBy: t.me.id,
          createdAt: new Date().toISOString(),
        });
        for (const c of task.comments) await t.mutate('comment', uuidv7(), { taskId: id, body: c.slice(0, 10000), authorId: t.me.id, createdAt: new Date().toISOString() });
        t.onProgress?.(++done, plan.taskCount);
        await addTasks(task.children, id);
      }
    };
    await addTasks(p.tasks, null);
  }
}
