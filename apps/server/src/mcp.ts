import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { fold, parseTask, type ParseContext } from '@do-it/parser';
import {
  addDays,
  completeTaskChanges,
  describeRecurrence,
  formatDateLong,
  formatDateRelative,
  generateKeyBetween,
  markdownToText,
  noteTaskIds,
  noteTitle,
  TASK_REF_LINE,
  type NoteData,
  occurrencesBetween,
  parseFilter,
  type FilterContext,
  uuidv7,
  zonedParts,
  type Mutation,
  type TaskData,
} from '@do-it/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { settingsOf, type UserRow } from './auth';
import type { Config } from './config';
import type { Db } from './db';
import { authenticateBearer, type BearerAuth } from './oauth';
import type { PushService } from './push';
import type { Hub } from './hub';
import type { SyncService } from './sync';
import { karmaSummary } from './karma';

interface Deps {
  db: Db;
  config: Config;
  sync: SyncService;
  push: PushService;
  hub: Hub;
}

interface TaskRow {
  id: string;
  project_id: string;
  data: TaskData;
  project_name: string;
  is_inbox: boolean;
}

interface NoteRow {
  id: string;
  project_id: string;
  data: NoteData;
  project_name: string;
  is_inbox: boolean;
}

interface ProjectRow {
  id: string;
  name: string;
  aliases: string[];
  is_inbox: boolean;
  role: string;
}

const INSTRUCTIONS = `Do-it ist die selbst gehostete Todo-App des Nutzers (Deutsch).
- Für Zusammenfassungen und Tagesbriefings zuerst get_overview aufrufen, bei Bedarf get_completed für Erledigtes.
- Gezielte Suchen mit find_tasks und "filter" in der Filtersprache, z. B. "(heute | überfällig) & p1" oder "deadline 7 tage".
- Termine (Arzt, Treffen …) mit add_tasks und "event": true eintragen; sie stehen im Kalender und werden nicht abgehakt. Regelmäßige Termine ohne Benachrichtigung (z. B. Stundenplan) zusätzlich mit "silent": true.
- Neue Aufgaben mit add_tasks anlegen. Das Feld "text" darf natürliche Sprache enthalten wie in der App, z. B. "morgen 15 Uhr Zahnarzt anrufen #Gesundheit !1" oder "jeden Montag Müll rausbringen +Ben". Do-it erkennt Datum, Uhrzeit, Wiederholung, Projekt (#), Label (@), Person (+) und Priorität (!1–!4) selbst.
- IDs aus den Ergebnissen für complete_tasks, update_task, add_comment und delete_task verwenden.
- Notizen (Markdown) mit find_notes suchen und mit get_note lesen; mit add_note anlegen und mit update_note ändern oder ergänzen. Eingebettete Aufgaben stehen dort als echte Aufgaben mit ID.
- Ein fertiges Briefing mit post_briefing speichern: Es erscheint in der App und als Benachrichtigung auf den Geräten des Nutzers.
- Antworte dem Nutzer auf Deutsch.`;

export function registerMcp(app: FastifyInstance, deps: Deps) {
  const { db, config } = deps;
  const resourceMeta = `${new URL(config.APP_URL).origin}/.well-known/oauth-protected-resource`;

  app.post('/mcp', async (req, reply) => {
    const auth = await authenticateBearer(db, req.headers.authorization);
    if (!auth) {
      return reply
        .code(401)
        .header('WWW-Authenticate', `Bearer resource_metadata="${resourceMeta}"`)
        .send({ jsonrpc: '2.0', error: { code: -32001, message: 'Anmeldung erforderlich' }, id: null });
    }
    const server = buildServer(deps, auth);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    // Das SDK schreibt direkt in die Node-Antwort: bereits gesetzte Header (CORS) mitnehmen.
    for (const [k, v] of Object.entries(reply.getHeaders())) if (v !== undefined) reply.raw.setHeader(k, v as string);
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  for (const method of ['GET', 'DELETE'] as const) {
    app.route({
      method,
      url: '/mcp',
      handler: async (_req, reply) =>
        reply.code(405).header('Allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Nur POST (zustandsloser Server)' }, id: null }),
    });
  }
}

// ---------- Hilfen ----------

function localNow(user: UserRow) {
  const p = zonedParts(new Date(), user.timezone);
  return { today: p.date, now: p.time };
}

async function visibleProjects(db: Db, userId: string): Promise<ProjectRow[]> {
  return db.query<ProjectRow>(
    `SELECT o.id, o.data->>'name' AS name, COALESCE(o.data->'aliases', '[]'::jsonb) AS aliases,
            COALESCE((o.data->>'isInbox')::boolean, false) AS is_inbox, pm.role
     FROM project_members pm JOIN objects o ON o.id = pm.project_id AND o.type = 'project' AND NOT o.deleted
     WHERE pm.user_id = $1 AND COALESCE((o.data->>'archived')::boolean, false) = false
     ORDER BY is_inbox DESC, o.data->>'sortKey'`,
    [userId],
  );
}

async function visibleTasks(db: Db, userId: string, where = 'TRUE', params: unknown[] = []): Promise<TaskRow[]> {
  return db.query<TaskRow>(
    `SELECT t.id, t.project_id, t.data, p.data->>'name' AS project_name, COALESCE((p.data->>'isInbox')::boolean, false) AS is_inbox
     FROM objects t
     JOIN project_members pm ON pm.project_id = t.project_id AND pm.user_id = $1
     JOIN objects p ON p.id = t.project_id AND NOT p.deleted
     WHERE t.type = 'task' AND NOT t.deleted AND (${where})
     ORDER BY t.data->>'dueDate' NULLS LAST, t.data->>'dueTime' NULLS LAST, (t.data->>'priority')::int, t.data->>'sortKey'`,
    [userId, ...params],
  );
}

async function visibleNotes(db: Db, userId: string, where = 'TRUE', params: unknown[] = []): Promise<NoteRow[]> {
  return db.query<NoteRow>(
    `SELECT n.id, n.project_id, n.data, p.data->>'name' AS project_name, COALESCE((p.data->>'isInbox')::boolean, false) AS is_inbox
     FROM objects n
     JOIN project_members pm ON pm.project_id = n.project_id AND pm.user_id = $1
     JOIN objects p ON p.id = n.project_id AND NOT p.deleted
     WHERE n.type = 'note' AND NOT n.deleted AND (${where})
     ORDER BY COALESCE((n.data->>'pinned')::boolean, false) DESC, n.data->>'updatedAt' DESC`,
    [userId, ...params],
  );
}

async function memberNames(db: Db, userId: string): Promise<Map<string, string>> {
  const rows = await db.query<{ user_id: string; name: string }>(
    `SELECT DISTINCT u.id AS user_id, u.name FROM project_members a JOIN project_members b ON b.project_id = a.project_id
     JOIN users u ON u.id = b.user_id WHERE a.user_id = $1`,
    [userId],
  );
  return new Map(rows.map((r) => [r.user_id, r.name]));
}

function line(t: TaskRow, today: string, names: Map<string, string>, opts: { project?: boolean } = {}): string {
  const d = t.data;
  const parts = [d.isEvent ? `[Termin] ${d.title}` : d.completedAt ? `[erledigt] ${d.title}` : d.title];
  if (d.dueDate) parts.push(`fällig ${formatDateRelative(d.dueDate, today)}${d.dueTime ? ` ${d.dueTime}` : ''}`);
  if (d.recurrence) parts.push(describeRecurrence(d.recurrence));
  if (d.deadline) parts.push(`Deadline ${formatDateRelative(d.deadline, today)}`);
  if (d.priority < 4) parts.push(`P${d.priority}`);
  if (opts.project !== false) parts.push(t.is_inbox ? 'Eingang' : `#${t.project_name}`);
  if (d.labels.length) parts.push(d.labels.map((l) => `@${l}`).join(' '));
  if (d.assigneeId) parts.push(`zuständig: ${names.get(d.assigneeId) ?? '?'}`);
  if (d.durationMin) parts.push(`${d.durationMin} Min.`);
  return `- ${parts.join(' · ')} (id: ${t.id})`;
}

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

function fail(s: string) {
  return { content: [{ type: 'text' as const, text: s }], isError: true };
}

async function parseContext(db: Db, user: UserRow): Promise<ParseContext> {
  const projects = await visibleProjects(db, user.id);
  const names = await memberNames(db, user.id);
  const labels = await db.query<{ name: string }>(`SELECT data->>'name' AS name FROM objects WHERE type = 'label' AND owner_id = $1 AND NOT deleted`, [
    user.id,
  ]);
  const s = settingsOf(user);
  return {
    ...localNow(user),
    userId: user.id,
    projects: projects.map((p) => ({ id: p.id, name: p.name, aliases: p.aliases, isInbox: p.is_inbox })),
    members: [...names].map(([id, name]) => ({ id, name })),
    labels: labels.map((l) => l.name),
    times: { morning: s.morningTime, noon: s.noonTime, afternoon: s.afternoonTime, evening: s.eveningTime, night: s.nightTime, workEnd: s.workEndTime },
  };
}

function findProject(projects: ProjectRow[], name: string): ProjectRow | undefined {
  const n = fold(name.replace(/^#/, '').trim());
  if (/^(eingang|inbox)$/.test(n)) return projects.find((p) => p.is_inbox);
  return projects.find((p) => fold(p.name) === n) ?? projects.find((p) => fold(p.name).startsWith(n));
}

// ---------- Server mit Werkzeugen ----------

function buildServer(deps: Deps, auth: BearerAuth): McpServer {
  const { db, sync, push, hub } = deps;
  const user = auth.user;
  const canWrite = auth.scopes.has('tasks:write');
  const server = new McpServer({ name: 'do-it', title: 'Do-it', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  const denied = () => fail('Für diese Aktion fehlt die Schreibberechtigung (tasks:write).');

  async function apply(changes: Omit<Mutation, 'mid' | 'hlc'>[]): Promise<string | null> {
    const res = await sync.applyAs(user, changes);
    return res.rejected[0]?.reason ?? null;
  }

  server.registerTool(
    'get_overview',
    {
      title: 'Überblick',
      description:
        'Überblick über die Aufgaben des Nutzers: Überfälliges, Heute, die nächsten 7 Tage, kürzlich Erledigtes und Projekte. Ideal als Grundlage für eine Tageszusammenfassung.',
      inputSchema: { days: z.number().int().min(1).max(31).default(7).describe('Wie viele Tage voraus (Standard 7)') },
      annotations: { readOnlyHint: true },
    },
    async ({ days }) => {
      const { today, now } = localNow(user);
      const until = addDays(today, days);
      const names = await memberNames(db, user.id);
      const open = await visibleTasks(db, user.id, `t.data->>'completedAt' IS NULL`);
      const mineAll = open.filter((t) => !t.data.assigneeId || t.data.assigneeId === user.id);
      const mine = mineAll.filter((t) => !t.data.isEvent);
      const agenda = mineAll
        .filter((t) => t.data.isEvent && t.data.dueDate)
        .flatMap((t) => occurrencesBetween(t.data.dueDate!, t.data.recurrence, today, until).map((date) => ({ t, date })))
        .sort((a, b) => (a.date + (a.t.data.dueTime ?? '')).localeCompare(b.date + (b.t.data.dueTime ?? '')));
      const overdue = mine.filter((t) => t.data.dueDate && t.data.dueDate < today);
      const todays = mine.filter((t) => t.data.dueDate === today);
      const upcoming = mine.filter((t) => t.data.dueDate && t.data.dueDate > today && t.data.dueDate <= until);
      const noDate = mine.filter((t) => !t.data.dueDate && !t.data.parentId);
      const others = open.filter((t) => t.data.assigneeId && t.data.assigneeId !== user.id && t.data.dueDate && t.data.dueDate <= today);
      const done = await db.query<{ summary: string; created_at: Date }>(
        `SELECT a.summary, a.created_at FROM activity a JOIN project_members pm ON pm.project_id = a.project_id AND pm.user_id = $1
         WHERE a.kind = 'completed' AND a.created_at > now() - interval '24 hours' ORDER BY a.id DESC LIMIT 30`,
        [user.id],
      );
      const projects = await visibleProjects(db, user.id);
      const out: string[] = [`# Überblick für ${user.name} – ${formatDateLong(today)}, ${now} Uhr`];
      const section = (title: string, list: TaskRow[]) => {
        out.push(`\n## ${title} (${list.length})`);
        out.push(list.length ? list.slice(0, 60).map((t) => line(t, today, names)).join('\n') : '- nichts');
      };
      out.push(`\n## Termine (${agenda.length})`);
      out.push(
        agenda.length
          ? agenda
              .slice(0, 60)
              .map(({ t, date }) => `- ${formatDateRelative(date, today)}${t.data.dueTime ? ` ${t.data.dueTime}` : ''}${t.data.durationMin ? ` (${t.data.durationMin} min)` : ''}: ${t.data.title} (id: ${t.id})`)
              .join('\n')
          : '- keine',
      );
      section('Überfällig', overdue);
      section('Heute', todays);
      section(`Nächste ${days} Tage`, upcoming);
      if (others.length) section('Heute fällig bei anderen', others);
      out.push(`\n## Ohne Datum\n- ${noDate.length} offene Aufgaben ohne Datum`);
      out.push(`\n## Erledigt in den letzten 24 Stunden (${done.length})`);
      out.push(done.length ? done.map((d) => `- ${d.summary}`).join('\n') : '- nichts');
      const k = await karmaSummary(db, user);
      if (k.enabled) {
        out.push(
          `\n## Karma\n- Stufe ${k.level.level} (${k.level.name}), ${k.points} Punkte${k.level.next ? `, noch ${k.level.next.min - k.points} bis ${k.level.next.name}` : ''}` +
            `\n- Heute ${k.today.done} von ${k.today.goal} erledigt (Tagesziel), diese Woche ${k.week.done} von ${k.week.goal}` +
            `\n- Serie: ${k.streak.current} Tage in Folge (Rekord ${k.streak.best})`,
        );
      }
      out.push('\n## Projekte');
      for (const p of projects) {
        const count = open.filter((t) => t.project_id === p.id && !t.data.parentId).length;
        out.push(`- ${p.is_inbox ? 'Eingang' : p.name}: ${count} offen`);
      }
      return text(out.join('\n'));
    },
  );

  server.registerTool(
    'find_tasks',
    {
      title: 'Aufgaben suchen',
      description:
        'Aufgaben suchen und filtern (Text, Projekt, Label, Zeitraum, Status, Zuständigkeit). Für komplexe Abfragen "filter" in der Do-it-Filtersprache nutzen, z. B. "heute | überfällig", "#Arbeit & p1", "7 tage & !wiederkehrend", "deadline 14 tage", "mir zugewiesen".',
      inputSchema: {
        filter: z.string().max(500).optional().describe('Abfrage in der Filtersprache (& und, | oder, ! nicht, Klammern; heute, morgen, überfällig, 7 tage, p1, #Projekt, @label, deadline …)'),
        query: z.string().max(200).optional().describe('Suchtext in Titel oder Beschreibung'),
        project: z.string().max(120).optional().describe('Projektname, z. B. "Haushalt" oder "Eingang"'),
        label: z.string().max(60).optional(),
        due_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('fällig ab (YYYY-MM-DD)'),
        due_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('fällig bis (YYYY-MM-DD)'),
        status: z.enum(['open', 'completed', 'all']).default('open'),
        assigned_to_me: z.boolean().default(false),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const { today } = localNow(user);
      const names = await memberNames(db, user.id);
      let list = await visibleTasks(db, user.id);
      if (a.status === 'open') list = list.filter((t) => !t.data.completedAt);
      if (a.status === 'completed') list = list.filter((t) => t.data.completedAt);
      if (a.filter) {
        const parsed = parseFilter(a.filter);
        if (!parsed.ok) return fail(`Filter: ${parsed.error}`);
        const projects = await db.query<{ id: string; name: string; parent_id: string | null; is_inbox: boolean }>(
          `SELECT o.id, o.data->>'name' AS name, o.data->>'parentId' AS parent_id, COALESCE((o.data->>'isInbox')::boolean, false) AS is_inbox
           FROM project_members pm JOIN objects o ON o.id = pm.project_id AND o.type = 'project' AND NOT o.deleted WHERE pm.user_id = $1`,
          [user.id],
        );
        const sections = await db.query<{ id: string; name: string }>(
          `SELECT s.id, s.data->>'name' AS name FROM objects s JOIN project_members pm ON pm.project_id = s.project_id AND pm.user_id = $1
           WHERE s.type = 'section' AND NOT s.deleted`,
          [user.id],
        );
        const ctx: FilterContext = {
          today,
          meId: user.id,
          projects: projects.map((p) => ({ id: p.id, name: p.name, parentId: p.parent_id, isInbox: p.is_inbox })),
          sections,
          members: [...names].map(([userId, name]) => ({ userId, name })),
        };
        list = list.filter((t) => parsed.filter.test(t.data, ctx));
      }
      if (a.query) {
        const q = fold(a.query);
        list = list.filter((t) => fold(t.data.title).includes(q) || fold(t.data.description).includes(q));
      }
      if (a.project) {
        const p = findProject(await visibleProjects(db, user.id), a.project);
        if (!p) return fail(`Projekt „${a.project}“ nicht gefunden.`);
        list = list.filter((t) => t.project_id === p.id);
      }
      if (a.label) list = list.filter((t) => t.data.labels.some((l) => fold(l) === fold(a.label!.replace(/^@/, ''))));
      if (a.due_from) list = list.filter((t) => t.data.dueDate && t.data.dueDate >= a.due_from!);
      if (a.due_to) list = list.filter((t) => t.data.dueDate && t.data.dueDate <= a.due_to!);
      if (a.assigned_to_me) list = list.filter((t) => t.data.assigneeId === user.id);
      const shown = list.slice(0, a.limit);
      return text(
        shown.length
          ? `${list.length} Treffer${list.length > shown.length ? ` (erste ${shown.length})` : ''}:\n${shown.map((t) => line(t, today, names)).join('\n')}`
          : 'Keine passenden Aufgaben.',
      );
    },
  );

  server.registerTool(
    'list_projects',
    {
      title: 'Projekte',
      description: 'Alle Projekte mit Anzahl offener Aufgaben, Mitgliedern und eigener Rolle.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const projects = await visibleProjects(db, user.id);
      const open = await visibleTasks(db, user.id, `t.data->>'completedAt' IS NULL`);
      const members = await db.query<{ project_id: string; name: string }>(
        `SELECT pm.project_id, u.name FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ANY($1::uuid[])`,
        [projects.map((p) => p.id)],
      );
      return text(
        projects
          .map((p) => {
            const m = members.filter((x) => x.project_id === p.id).map((x) => x.name);
            const count = open.filter((t) => t.project_id === p.id && !t.data.parentId).length;
            return `- ${p.is_inbox ? 'Eingang' : p.name}: ${count} offen · Rolle: ${p.role}${m.length > 1 ? ` · Mitglieder: ${m.join(', ')}` : ''}${
              p.aliases.length ? ` · Stichwörter: ${p.aliases.join(', ')}` : ''
            } (id: ${p.id})`;
          })
          .join('\n'),
      );
    },
  );

  server.registerTool(
    'add_tasks',
    {
      title: 'Aufgaben anlegen',
      description:
        'Legt eine oder mehrere Aufgaben an. "text" in natürlicher Sprache wie in der App: Datum, Uhrzeit, Wiederholung, #Projekt, @Label, +Person, !1–!4 und Erinnerungen ("erinnere mich 30 min vorher") werden erkannt.',
      inputSchema: {
        tasks: z
          .array(
            z.object({
              text: z.string().min(1).max(500).describe('z. B. "morgen 15 Uhr Zahnarzt anrufen #Gesundheit"'),
              description: z.string().max(5000).optional(),
              project: z.string().max(120).optional().describe('Projektname; überschreibt #Projekt im Text'),
              parent_id: z.string().uuid().optional().describe('ID einer Hauptaufgabe für Unteraufgaben'),
              event: z.boolean().optional().describe('true: als Termin im Kalender eintragen (kein To-do, wird nicht abgehakt); braucht ein Datum'),
              silent: z.boolean().optional().describe('true: ohne Benachrichtigung (keine Erinnerung, nicht im Morgen-Briefing), z. B. für einen Stundenplan'),
            }),
          )
          .min(1)
          .max(50),
      },
    },
    async ({ tasks }) => {
      if (!canWrite) return denied();
      const ctx = await parseContext(db, user);
      const projects = await visibleProjects(db, user.id);
      const inbox = projects.find((p) => p.is_inbox)!;
      const results: string[] = [];
      for (const item of tasks) {
        const r = parseTask(item.text, ctx);
        if (!r.title) {
          results.push(`- „${item.text}“: kein Titel erkannt`);
          continue;
        }
        if (item.event && !r.dueDate) {
          results.push(`- „${r.title}“: Ein Termin braucht ein Datum`);
          continue;
        }
        const changes: Omit<Mutation, 'mid' | 'hlc'>[] = [];
        let projectId = r.projectId ?? inbox.id;
        let parentId: string | null = null;
        if (item.parent_id) {
          const parent = await db.one<{ project_id: string }>(`SELECT project_id FROM objects WHERE id = $1 AND type = 'task' AND NOT deleted`, [item.parent_id]);
          if (!parent) {
            results.push(`- „${r.title}“: Hauptaufgabe nicht gefunden`);
            continue;
          }
          parentId = item.parent_id;
          projectId = parent.project_id;
        } else if (item.project) {
          const p = findProject(projects, item.project);
          if (!p) {
            results.push(`- „${r.title}“: Projekt „${item.project}“ nicht gefunden`);
            continue;
          }
          projectId = p.id;
        } else if (r.newProjectName) {
          projectId = uuidv7();
          const last = await db.one<{ k: string | null }>(
            `SELECT max(o.data->>'sortKey') AS k FROM objects o JOIN project_members pm ON pm.project_id = o.id AND pm.user_id = $1 WHERE o.type = 'project' AND NOT o.deleted`,
            [user.id],
          );
          changes.push({ type: 'project', id: projectId, op: 'put', data: { name: r.newProjectName, sortKey: generateKeyBetween(last?.k ?? null, null) } });
        }
        const existingLabels = new Set((ctx.labels ?? []).map((l) => l.toLowerCase()));
        for (const l of r.labels) {
          if (!existingLabels.has(l.toLowerCase())) {
            changes.push({ type: 'label', id: uuidv7(), op: 'put', data: { name: l, color: null } });
            existingLabels.add(l.toLowerCase());
            ctx.labels = [...(ctx.labels ?? []), l];
          }
        }
        const last = await db.one<{ k: string | null }>(
          `SELECT max(data->>'sortKey') AS k FROM objects WHERE type = 'task' AND project_id = $1 AND NOT deleted AND data->>'parentId' IS NOT DISTINCT FROM $2`,
          [projectId, parentId],
        );
        const id = uuidv7();
        changes.push({
          type: 'task',
          id,
          op: 'put',
          data: {
            projectId,
            parentId,
            title: r.title,
            description: item.description ?? '',
            priority: r.priority,
            dueDate: r.dueDate,
            dueTime: r.dueTime,
            deadline: r.deadline,
            durationMin: r.durationMin,
            recurrence: r.recurrence,
            assigneeId: r.assigneeId,
            rotation: r.rotation,
            labels: r.labels,
            sortKey: generateKeyBetween(last?.k ?? null, null),
            createdAt: new Date().toISOString(),
            ...(item.event ? { isEvent: true, priority: 4 } : {}),
            ...(item.silent || r.silent ? { silent: true } : {}),
          },
        });
        const reminders = item.silent || r.silent ? [] : [...r.reminders];
        const auto = settingsOf(user).autoReminderMin;
        if (!reminders.length && !item.silent && !r.silent && auto !== null && r.dueDate && r.dueTime) reminders.push({ kind: 'relative', offsetMin: auto });
        for (const rem of reminders) {
          changes.push({
            type: 'reminder',
            id: uuidv7(),
            op: 'put',
            data:
              rem.kind === 'relative'
                ? { taskId: id, kind: 'relative', offsetMin: rem.offsetMin, date: null, time: null }
                : { taskId: id, kind: 'absolute', offsetMin: null, date: rem.date, time: rem.time },
          });
        }
        const err = await apply(changes);
        if (err) {
          results.push(`- „${r.title}“: abgelehnt (${err})`);
          continue;
        }
        const pname = r.newProjectName ?? projects.find((p) => p.id === projectId)?.name ?? 'Eingang';
        const bits = [
          r.dueDate ? `fällig ${formatDateRelative(r.dueDate, ctx.today)}${r.dueTime ? ` ${r.dueTime}` : ''}` : null,
          r.recurrence ? describeRecurrence(r.recurrence) : null,
          `#${pname}`,
          r.priority < 4 ? `P${r.priority}` : null,
          reminders.length ? `${reminders.length} Erinnerung(en)` : null,
        ].filter(Boolean);
        results.push(`- „${r.title}“ angelegt · ${bits.join(' · ')} (id: ${id})${r.warnings.length ? ` – Hinweis: ${r.warnings.join('; ')}` : ''}`);
      }
      return text(results.join('\n'));
    },
  );

  server.registerTool(
    'complete_tasks',
    {
      title: 'Aufgaben abhaken',
      description: 'Hakt Aufgaben ab. Wiederkehrende Aufgaben springen zum nächsten Termin (inkl. Rotation der Zuständigkeit).',
      inputSchema: { ids: z.array(z.string().uuid()).min(1).max(50) },
    },
    async ({ ids }) => {
      if (!canWrite) return denied();
      const { today } = localNow(user);
      const out: string[] = [];
      for (const id of ids) {
        const t = (await visibleTasks(db, user.id, 't.id = $2', [id]))[0];
        if (!t) {
          out.push(`- ${id}: nicht gefunden`);
          continue;
        }
        if (t.data.completedAt) {
          out.push(`- „${t.data.title}“ war schon erledigt`);
          continue;
        }
        if (t.data.isEvent) {
          out.push(`- „${t.data.title}“ ist ein Termin und wird nicht abgehakt`);
          continue;
        }
        const changes = completeTaskChanges(t.data, today, user.id, new Date().toISOString());
        const err = await apply([{ type: 'task', id, op: 'put', data: changes as Record<string, unknown> }]);
        out.push(
          err
            ? `- „${t.data.title}“: abgelehnt (${err})`
            : changes.dueDate
              ? `- „${t.data.title}“ erledigt, nächster Termin ${formatDateRelative(changes.dueDate, today)}`
              : `- „${t.data.title}“ erledigt`,
        );
      }
      return text(out.join('\n'));
    },
  );

  server.registerTool(
    'update_task',
    {
      title: 'Aufgabe ändern',
      description:
        'Ändert eine Aufgabe. Für Termine "due" in natürlicher Sprache nutzen (z. B. "nächsten Montag 9 Uhr", "jeden Freitag", "kein Datum").',
      inputSchema: {
        id: z.string().uuid(),
        title: z.string().min(1).max(500).optional(),
        description: z.string().max(20000).optional(),
        due: z.string().max(200).optional().describe('neuer Termin in natürlicher Sprache, oder "kein Datum"'),
        priority: z.number().int().min(1).max(4).optional().describe('1 = höchste, 4 = keine'),
        project: z.string().max(120).optional().describe('in dieses Projekt verschieben'),
        labels: z.array(z.string().max(60)).max(30).optional(),
        deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        assignee: z.string().max(80).nullable().optional().describe('Name eines Projektmitglieds oder null'),
        completed: z.boolean().optional().describe('false = wieder öffnen'),
      },
    },
    async (a) => {
      if (!canWrite) return denied();
      const t = (await visibleTasks(db, user.id, 't.id = $2', [a.id]))[0];
      if (!t) return fail('Aufgabe nicht gefunden.');
      const data: Record<string, unknown> = {};
      if (a.title) data.title = a.title;
      if (a.description !== undefined) data.description = a.description;
      if (a.priority) data.priority = a.priority;
      if (a.labels) data.labels = a.labels.map((l) => l.replace(/^@/, ''));
      if (a.deadline !== undefined) data.deadline = a.deadline;
      if (a.completed === false) Object.assign(data, { completedAt: null, completedBy: null });
      if (a.due !== undefined) {
        if (/^(kein(e)?\s+datum|ohne\s+datum|keins|none|null|-)$/i.test(a.due.trim())) Object.assign(data, { dueDate: null, dueTime: null, recurrence: null });
        else {
          const r = parseTask(`${a.due} x`, await parseContext(db, user));
          if (!r.dueDate && !r.recurrence) return fail(`„${a.due}“ als Termin nicht verstanden.`);
          Object.assign(data, { dueDate: r.dueDate, dueTime: r.dueTime, ...(r.recurrence ? { recurrence: r.recurrence } : {}) });
        }
      }
      if (a.project) {
        const p = findProject(await visibleProjects(db, user.id), a.project);
        if (!p) return fail(`Projekt „${a.project}“ nicht gefunden.`);
        if (p.id !== t.project_id) Object.assign(data, { projectId: p.id, sectionId: null });
      }
      if (a.assignee !== undefined) {
        if (a.assignee === null) data.assigneeId = null;
        else {
          const names = await memberNames(db, user.id);
          const hit = [...names].find(([, n]) => fold(n).startsWith(fold(a.assignee!)));
          if (!hit) return fail(`Person „${a.assignee}“ nicht gefunden.`);
          data.assigneeId = hit[0];
        }
      }
      if (!Object.keys(data).length) return fail('Nichts zu ändern.');
      const err = await apply([{ type: 'task', id: a.id, op: 'put', data }]);
      if (err) return fail(`Abgelehnt: ${err}`);
      const updated = (await visibleTasks(db, user.id, 't.id = $2', [a.id]))[0]!;
      return text(`Geändert:\n${line(updated, localNow(user).today, await memberNames(db, user.id))}`);
    },
  );

  server.registerTool(
    'delete_task',
    {
      title: 'Aufgabe löschen',
      description: 'Löscht eine Aufgabe samt Unteraufgaben endgültig. Nur auf ausdrücklichen Wunsch verwenden; sonst lieber abhaken.',
      inputSchema: { id: z.string().uuid() },
      annotations: { destructiveHint: true },
    },
    async ({ id }) => {
      if (!canWrite) return denied();
      const t = (await visibleTasks(db, user.id, 't.id = $2', [id]))[0];
      if (!t) return fail('Aufgabe nicht gefunden.');
      const err = await apply([{ type: 'task', id, op: 'delete' }]);
      return err ? fail(`Abgelehnt: ${err}`) : text(`„${t.data.title}“ gelöscht.`);
    },
  );

  server.registerTool(
    'add_comment',
    {
      title: 'Kommentar schreiben',
      description: 'Schreibt einen Kommentar an eine Aufgabe (sichtbar für alle Projektmitglieder).',
      inputSchema: { task_id: z.string().uuid(), text: z.string().min(1).max(10000) },
    },
    async (a) => {
      if (!canWrite) return denied();
      const err = await apply([
        { type: 'comment', id: uuidv7(), op: 'put', data: { taskId: a.task_id, body: a.text, authorId: user.id, createdAt: new Date().toISOString() } },
      ]);
      return err ? fail(`Abgelehnt: ${err}`) : text('Kommentar gespeichert.');
    },
  );

  server.registerTool(
    'find_notes',
    {
      title: 'Notizen suchen',
      description: 'Listet die Notizen des Nutzers (neueste zuerst), optional gefiltert nach Suchbegriff oder Projekt. Den Inhalt liefert get_note.',
      inputSchema: {
        query: z.string().max(200).optional().describe('Suchbegriff in Titel und Text'),
        project: z.string().max(120).optional().describe('Projektname'),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      let notes = await visibleNotes(db, user.id);
      if (a.project) {
        const p = findProject(await visibleProjects(db, user.id), a.project);
        if (!p) return fail(`Projekt „${a.project}“ nicht gefunden.`);
        notes = notes.filter((n) => n.project_id === p.id);
      }
      if (a.query?.trim()) {
        const q = fold(a.query.trim());
        notes = notes.filter((n) => fold(`${n.data.title}\n${markdownToText(n.data.body)}`).includes(q));
      }
      if (!notes.length) return text('Keine passenden Notizen.');
      const today = localNow(user).today;
      return text(
        notes
          .slice(0, 40)
          .map((n) => {
            const updated = formatDateRelative(zonedParts(new Date(n.data.updatedAt), user.timezone).date, today);
            const snippet = markdownToText(n.data.body).slice(0, 120);
            return `- ${n.data.pinned ? '[angeheftet] ' : ''}${noteTitle(n.data)} · ${n.is_inbox ? 'Eingang' : `#${n.project_name}`} · bearbeitet ${updated}${snippet ? ` · „${snippet}“` : ''} (id: ${n.id})`;
          })
          .join('\n'),
      );
    },
  );

  server.registerTool(
    'get_note',
    {
      title: 'Notiz lesen',
      description: 'Liefert eine Notiz als Markdown. Eingebettete Aufgaben erscheinen als Checklisten-Zeile mit Status, Fälligkeit und Aufgaben-ID.',
      inputSchema: { id: z.string().uuid() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const n = (await visibleNotes(db, user.id, 'n.id = $2', [id]))[0];
      if (!n) return fail('Notiz nicht gefunden.');
      const ids = noteTaskIds(n.data.body);
      const tasks = ids.length ? await visibleTasks(db, user.id, 't.id = ANY($2::uuid[])', [ids]) : [];
      const byId = new Map(tasks.map((t) => [t.id, t]));
      const today = localNow(user).today;
      const body = n.data.body.replace(TASK_REF_LINE, (_l, tid: string) => {
        const t = byId.get(tid.toLowerCase());
        if (!t) return '- [ ] (Aufgabe gelöscht oder nicht sichtbar)';
        const due = t.data.dueDate ? ` · fällig ${formatDateRelative(t.data.dueDate, today)}${t.data.dueTime ? ` ${t.data.dueTime}` : ''}` : '';
        return `- [${t.data.completedAt ? 'x' : ' '}] ${t.data.title}${due} (Aufgabe, id: ${t.id})`;
      });
      return text(`# ${noteTitle(n.data)}\nProjekt: ${n.is_inbox ? 'Eingang' : n.project_name}\n\n${body.trim()}`);
    },
  );

  server.registerTool(
    'add_note',
    {
      title: 'Notiz anlegen',
      description: 'Legt eine Notiz an (Markdown: Überschriften, Listen, Checklisten mit "- [ ]", **fett**). Ohne Projekt landet sie im Eingang.',
      inputSchema: {
        title: z.string().min(1).max(200),
        text: z.string().max(100_000).default(''),
        project: z.string().max(120).optional(),
      },
    },
    async (a) => {
      if (!canWrite) return denied();
      const projects = await visibleProjects(db, user.id);
      const p = a.project ? findProject(projects, a.project) : projects.find((x) => x.is_inbox);
      if (!p) return fail(`Projekt „${a.project}“ nicht gefunden.`);
      const id = uuidv7();
      const now = new Date().toISOString();
      const err = await apply([{ type: 'note', id, op: 'put', data: { projectId: p.id, title: a.title, body: a.text, createdAt: now, updatedAt: now } }]);
      return err ? fail(`Abgelehnt: ${err}`) : text(`Notiz „${a.title}“ angelegt (id: ${id}).`);
    },
  );

  server.registerTool(
    'update_note',
    {
      title: 'Notiz ändern',
      description: 'Ändert Titel oder Text einer Notiz. Mit "append" wird Text unten angehängt (z. B. weitere Punkte einer Liste), mit "text" der ganze Inhalt ersetzt.',
      inputSchema: {
        id: z.string().uuid(),
        title: z.string().max(200).optional(),
        text: z.string().max(100_000).optional().describe('ersetzt den ganzen Inhalt – eingebettete Aufgaben ([[task:…]]-Zeilen) dabei erhalten'),
        append: z.string().max(20_000).optional(),
      },
    },
    async (a) => {
      if (!canWrite) return denied();
      const n = (await visibleNotes(db, user.id, 'n.id = $2', [a.id]))[0];
      if (!n) return fail('Notiz nicht gefunden.');
      const data: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      if (a.title !== undefined) data.title = a.title;
      if (a.text !== undefined) data.body = a.text;
      if (a.append) data.body = `${String(data.body ?? n.data.body).replace(/\s+$/, '')}\n\n${a.append}`;
      const err = await apply([{ type: 'note', id: a.id, op: 'put', data }]);
      return err ? fail(`Abgelehnt: ${err}`) : text(`Notiz „${noteTitle({ title: String(data.title ?? n.data.title), body: String(data.body ?? n.data.body) })}“ gespeichert.`);
    },
  );

  server.registerTool(
    'get_completed',
    {
      title: 'Erledigtes',
      description: 'Was wurde in den letzten Tagen erledigt (vom Nutzer und in geteilten Projekten)? Gut für Wochenrückblicke.',
      inputSchema: { days: z.number().int().min(1).max(90).default(7) },
      annotations: { readOnlyHint: true },
    },
    async ({ days }) => {
      const rows = await db.query<{ summary: string; created_at: Date }>(
        `SELECT a.summary, a.created_at FROM activity a JOIN project_members pm ON pm.project_id = a.project_id AND pm.user_id = $1
         WHERE a.kind = 'completed' AND a.created_at > now() - ($2 || ' days')::interval ORDER BY a.id DESC LIMIT 300`,
        [user.id, String(days)],
      );
      if (!rows.length) return text(`In den letzten ${days} Tagen wurde nichts erledigt.`);
      return text(
        `${rows.length} erledigt in den letzten ${days} Tagen:\n${rows
          .map((r) => {
            const p = zonedParts(new Date(r.created_at), user.timezone);
            return `- ${formatDateRelative(p.date, localNow(user).today)} ${p.time}: ${r.summary}`;
          })
          .join('\n')}`,
      );
    },
  );

  server.registerTool(
    'post_briefing',
    {
      title: 'Briefing speichern',
      description:
        'Speichert eine Zusammenfassung/ein Briefing für den Nutzer in Do-it. Es erscheint oben in "Heute" und als Benachrichtigung auf allen Geräten. Markdown (Überschriften, Listen, **fett**) ist erlaubt.',
      inputSchema: {
        title: z.string().min(1).max(120).default('Tagesbriefing'),
        text: z.string().min(1).max(20000),
        notify: z.boolean().default(true).describe('Benachrichtigung schicken'),
      },
    },
    async (a) => {
      if (!canWrite) return denied();
      const id = uuidv7();
      await db.query('INSERT INTO briefings(id, user_id, title, body, source) VALUES ($1, $2, $3, $4, $5)', [id, user.id, a.title, a.text, 'claude']);
      hub.poke([user.id]);
      let delivered = 0;
      if (a.notify) {
        const preview = a.text
          .replace(/[#*_`>]/g, '')
          .replace(/\n+/g, ' ')
          .trim()
          .slice(0, 160);
        delivered = await push.sendToUser(user.id, { title: a.title, body: preview, tag: `briefing-${id}`, url: '/briefings' });
      }
      return text(`Briefing gespeichert${a.notify ? ` und an ${delivered} Gerät(e) geschickt` : ''}.`);
    },
  );

  server.registerPrompt(
    'tagesbriefing',
    {
      title: 'Tagesbriefing schreiben',
      description: 'Liest die Aufgaben und schreibt ein kurzes Tagesbriefing in Do-it.',
    },
    () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              'Erstelle mein Tagesbriefing für Do-it: Rufe get_overview auf. Schreibe dann auf Deutsch ein kurzes, freundliches Briefing (höchstens 12 Zeilen): ' +
              'was heute wichtig ist (Termine mit Uhrzeit zuerst), was überfällig ist, was in den nächsten Tagen ansteht und was gestern geschafft wurde. ' +
              'Schlage höchstens drei Prioritäten für heute vor. Speichere das Ergebnis mit post_briefing (Titel "Tagesbriefing").',
          },
        },
      ],
    }),
  );

  return server;
}
