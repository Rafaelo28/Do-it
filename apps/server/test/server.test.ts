import { randomUUID } from 'node:crypto';
import { formatHlc, uuidv7, zonedParts, zonedToUtc, type Mutation, type PullResponse, type SyncObject } from '@do-it/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createDb, type Db } from '../src/db';
import { migrate } from '../src/migrations';
import type { PushService } from '../src/push';
import { processBriefings, processDueReminders } from '../src/reminders';

const BASE = process.env.TEST_DATABASE_URL ?? 'postgres://doit:doit@localhost:5432/doit';
const ORIGIN = 'http://localhost:8080';

type App = Awaited<ReturnType<typeof buildApp>>['app'];

let app: App;
let db: Db;
let push: PushService;
let dbName: string;
const sent: { endpoint: string; payload: Record<string, unknown> }[] = [];

class Client {
  cookie = '';
  constructor(private readonly origin = ORIGIN) {}

  async req<T = Record<string, unknown>>(method: string, url: string, body?: unknown): Promise<{ status: number; json: T; text: string }> {
    const res = await app.inject({
      method: method as 'GET',
      url,
      payload: body as object,
      headers: { cookie: this.cookie, origin: this.origin },
    });
    const setCookie = res.headers['set-cookie'];
    const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (first) this.cookie = first.split(';')[0]!;
    let json: T = {} as T;
    try {
      json = JSON.parse(res.body) as T;
    } catch {
      /* kein JSON */
    }
    return { status: res.statusCode, json, text: res.body };
  }

  pull(cursor = 0, project?: string) {
    return this.req<PullResponse>('GET', `/api/sync/pull?cursor=${cursor}${project ? `&project=${project}` : ''}`);
  }

  push(mutations: Partial<Mutation>[]) {
    let i = 0;
    return this.req<{ applied: string[]; rejected: { mid: string; reason: string }[] }>('POST', '/api/sync/push', {
      clientId: 'test',
      mutations: mutations.map((m) => ({ mid: randomUUID(), op: 'put', hlc: formatHlc(Date.now(), i++, 'c1'), ...m })),
    });
  }
}

let hlcCounter = 0;
const hlcAt = (ms: number) => formatHlc(ms, hlcCounter++, 'c1');

beforeAll(async () => {
  dbName = `doit_t_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: BASE });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const url = new URL(BASE);
  url.pathname = `/${dbName}`;
  db = createDb(url.toString());
  await migrate(db);
  const config = loadConfig({ DATABASE_URL: url.toString(), APP_URL: ORIGIN } as NodeJS.ProcessEnv);
  const built = await buildApp({
    config,
    db,
    pushTransport: {
      async send(sub, payload) {
        sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) as Record<string, unknown> });
        return sub.endpoint.includes('gone') ? 410 : 201;
      },
    },
  });
  app = built.app;
  push = built.push;
});

afterAll(async () => {
  await app?.close();
  await db?.close();
  const admin = new pg.Client({ connectionString: BASE });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

const anna = new Client();
const ben = new Client();
const mallory = new Client('https://evil.example');
let annaInbox = '';
let annaId = '';
let benId = '';
const haushalt = uuidv7();
const task1 = uuidv7();

function obj(p: PullResponse, id: string): SyncObject | undefined {
  return p.objects.find((o) => o.id === id);
}

describe('Server', () => {
  it('Ersteinrichtung legt Admin mit Eingang an', async () => {
    expect((await anna.req('GET', '/api/auth/status')).json).toEqual({ setupRequired: true, user: null });
    const res = await anna.req<{ user: { id: string; isAdmin: boolean } }>('POST', '/api/auth/setup', {
      name: 'Anna',
      email: 'Anna@Example.org',
      password: 'geheim1234',
      timezone: 'Europe/Berlin',
    });
    expect(res.status).toBe(200);
    expect(res.json.user.isAdmin).toBe(true);
    annaId = res.json.user.id;
    const again = await new Client().req('POST', '/api/auth/setup', { name: 'X', email: 'x@example.org', password: 'geheim1234' });
    expect(again.status).toBe(409);

    const pull = await anna.pull();
    expect(pull.status).toBe(200);
    expect(pull.json.projectIds).toHaveLength(1);
    const inbox = pull.json.objects.find((o) => o.type === 'project')!;
    expect(inbox.data).toMatchObject({ name: 'Eingang', isInbox: true });
    annaInbox = inbox.id;
  });

  it('Login, falsches Passwort und fremde Origin', async () => {
    const c = new Client();
    expect((await c.req('POST', '/api/auth/login', { email: 'anna@example.org', password: 'falsch' })).status).toBe(401);
    expect((await c.req('POST', '/api/auth/login', { email: 'ANNA@example.org', password: 'geheim1234' })).status).toBe(200);
    expect((await c.req('GET', '/api/me')).status).toBe(200);
    expect((await mallory.req('POST', '/api/auth/login', { email: 'anna@example.org', password: 'geheim1234' })).status).toBe(403);
    expect((await new Client().req('GET', '/api/sync/pull')).status).toBe(401);
  });

  it('Projekt und Aufgaben anlegen, idempotent', async () => {
    const mid = randomUUID();
    const body = {
      clientId: 'c1',
      mutations: [
        { mid, type: 'project', id: haushalt, op: 'put', hlc: hlcAt(Date.now()), data: { name: 'Haushalt', sortKey: 'a1' } },
        {
          mid: randomUUID(),
          type: 'task',
          id: task1,
          op: 'put',
          hlc: hlcAt(Date.now()),
          data: { projectId: haushalt, title: 'Bad putzen', sortKey: 'a0', createdAt: new Date().toISOString() },
        },
      ],
    };
    const r1 = await anna.req<{ applied: string[]; rejected: unknown[] }>('POST', '/api/sync/push', body);
    expect(r1.json.rejected).toEqual([]);
    const before = await anna.pull();
    const r2 = await anna.req<{ applied: string[] }>('POST', '/api/sync/push', body);
    expect(r2.json.applied).toHaveLength(2);
    const after = await anna.pull();
    expect(after.json.cursor).toBe(before.json.cursor);
    expect(obj(after.json, task1)?.data).toMatchObject({ title: 'Bad putzen', priority: 4, createdBy: annaId, labels: [] });
  });

  it('ungültige Daten werden abgelehnt, der Rest übernommen', async () => {
    const res = await anna.push([
      { type: 'task', id: uuidv7(), data: { projectId: haushalt, title: '', createdAt: 'x' } },
      { type: 'task', id: uuidv7(), data: { projectId: haushalt, title: 'Fenster', createdAt: 'x' } },
    ]);
    expect(res.json.rejected).toHaveLength(1);
    expect(res.json.applied).toHaveLength(1);
  });

  it('feldweises Zusammenführen: neuere Änderung gewinnt je Feld', async () => {
    const t = Date.now();
    await anna.push([{ type: 'task', id: task1, hlc: hlcAt(t + 10), data: { title: 'Bad gründlich putzen' } }]);
    await anna.push([{ type: 'task', id: task1, hlc: hlcAt(t + 5), data: { title: 'veraltet', priority: 1 } }]);
    const p = await anna.pull();
    expect(obj(p.json, task1)?.data).toMatchObject({ title: 'Bad gründlich putzen', priority: 1 });
  });

  it('Einladung: neues Konto, Projekt teilen, Rechte', async () => {
    const invite = await anna.req<{ token: string; url: string }>('POST', '/api/invites', {});
    expect(invite.status).toBe(200);
    expect(invite.json.url).toContain('/invite/');
    expect((await ben.req('GET', `/api/invites/${invite.json.token}`)).json).toMatchObject({ valid: true, invitedBy: 'Anna' });
    const reg = await ben.req<{ user: { id: string } }>('POST', '/api/auth/register', {
      token: invite.json.token,
      name: 'Ben',
      email: 'ben@example.org',
      password: 'passwort123',
    });
    expect(reg.status).toBe(200);
    benId = reg.json.user.id;
    expect((await new Client().req('POST', '/api/auth/register', { token: invite.json.token, name: 'C', email: 'c@example.org', password: 'passwort123' })).status).toBe(400);

    // Ben sieht Annas Projekt nicht und darf dort nichts anlegen
    let p = await ben.pull();
    expect(obj(p.json, haushalt)).toBeUndefined();
    const denied = await ben.push([{ type: 'task', id: uuidv7(), data: { projectId: haushalt, title: 'Hack', createdAt: 'x' } }]);
    expect(denied.json.rejected[0]?.reason).toMatch(/Schreibrechte/);
    expect((await ben.pull(0, haushalt)).status).toBe(403);

    // Ben (kein Admin) darf keine Konto-Einladungen erzeugen, Anna lädt in Projekt ein
    expect((await ben.req('POST', '/api/invites', {})).status).toBe(403);
    expect((await anna.req('POST', '/api/invites', { projectId: annaInbox })).status).toBe(400);
    const pinv = await anna.req<{ token: string }>('POST', '/api/invites', { projectId: haushalt });
    expect((await ben.req('POST', `/api/invites/${pinv.json.token}/accept`)).json).toEqual({ projectId: haushalt });

    p = await ben.pull();
    expect(p.json.projectIds).toContain(haushalt);
    const snap = await ben.pull(0, haushalt);
    expect(obj(snap.json, task1)?.data.title).toBe('Bad gründlich putzen');
    expect(p.json.members.filter((m) => m.projectId === haushalt).map((m) => m.name).sort()).toEqual(['Anna', 'Ben']);

    // Ben ändert, Anna sieht es; Ben darf das Projekt nicht umbenennen
    const cursor = (await anna.pull()).json.cursor;
    await ben.push([{ type: 'task', id: task1, data: { assigneeId: annaId } }]);
    const changes = await anna.pull(cursor);
    expect(obj(changes.json, task1)?.data.assigneeId).toBe(annaId);
    const rename = await ben.push([{ type: 'project', id: haushalt, data: { name: 'Meins' } }]);
    expect(rename.json.rejected).toHaveLength(1);

    // Zuweisen nur an Mitglieder; Hauptaufgabe muss im selben Projekt liegen
    const stranger = await ben.push([{ type: 'task', id: uuidv7(), data: { projectId: haushalt, title: 'X', assigneeId: uuidv7(), createdAt: 'x' } }]);
    expect(stranger.json.rejected[0]?.reason).toMatch(/kein Mitglied/);
    const wrongParent = await anna.push([{ type: 'task', id: uuidv7(), data: { projectId: annaInbox, parentId: task1, title: 'Y', createdAt: 'x' } }]);
    expect(wrongParent.json.rejected[0]?.reason).toMatch(/anderen Projekt/);

    const members = await anna.req<{ members: { role: string }[] }>('GET', `/api/projects/${haushalt}/members`);
    expect(members.json.members.map((m) => m.role)).toEqual(['owner', 'editor']);
    const activity = await anna.req<{ activity: { summary: string }[] }>('GET', `/api/projects/${haushalt}/activity`);
    expect(activity.json.activity.some((a) => a.summary.includes('Bad putzen'))).toBe(true);
  });

  it('Zuweisung löst Benachrichtigung aus, abgelaufene Geräte werden entfernt', async () => {
    await ben.req('POST', '/api/push/subscription', { endpoint: 'https://push.example/ben-1', keys: { p256dh: 'k', auth: 'a' } });
    await ben.req('POST', '/api/push/subscription', { endpoint: 'https://push.example/gone-ben', keys: { p256dh: 'k', auth: 'a' } });
    sent.length = 0;
    await anna.push([{ type: 'task', id: uuidv7(), data: { projectId: haushalt, title: 'Müll rausbringen', assigneeId: benId, createdAt: 'x' } }]);
    expect(sent.map((s) => s.payload.title)).toContain('Neue Aufgabe für dich');
    const devices = await db.query<{ endpoint: string }>('SELECT endpoint FROM push_subscriptions WHERE user_id = $1', [benId]);
    expect(devices.map((d) => d.endpoint)).toEqual(['https://push.example/ben-1']);
  });

  it('Erinnerung wird geplant, verschickt und per Aktion erledigt', async () => {
    await anna.req('POST', '/api/push/subscription', { endpoint: 'https://push.example/anna-1', keys: { p256dh: 'k', auth: 'a' } });
    const local = zonedParts(new Date(Date.now() + 3 * 3600_000), 'Europe/Berlin');
    const taskId = uuidv7();
    const reminderId = uuidv7();
    await anna.push([
      { type: 'task', id: taskId, data: { projectId: annaInbox, title: 'Zahnarzt anrufen', dueDate: local.date, dueTime: local.time, createdAt: 'x' } },
      { type: 'reminder', id: reminderId, data: { taskId, kind: 'relative', offsetMin: 30 } },
    ]);
    const sched = await db.one<{ fire_at: Date }>('SELECT fire_at FROM reminder_schedule WHERE reminder_id = $1', [reminderId]);
    const expected = zonedToUtc(local.date, local.time, 'Europe/Berlin').getTime() - 30 * 60_000;
    expect(new Date(sched!.fire_at).getTime()).toBe(expected);

    sent.length = 0;
    expect((await processDueReminders(db, push, new Date(expected - 1000))).sent).toBe(0);
    expect((await processDueReminders(db, push, new Date(expected + 1000))).sent).toBe(1);
    expect((await processDueReminders(db, push, new Date(expected + 2000))).sent).toBe(0);
    const msg = sent.find((s) => s.payload.taskId === taskId)!;
    expect(msg.payload).toMatchObject({ title: 'Zahnarzt anrufen' });
    const tokens = msg.payload.tokens as Record<string, string>;

    // Aktion "Erledigt" ohne Login-Cookie, nur mit Token
    const res = await new Client().req('POST', '/api/push/action', { token: tokens.done });
    expect(res.status).toBe(200);
    const p = await anna.pull();
    expect(obj(p.json, taskId)?.data.completedAt).toBeTruthy();
    expect(await db.one('SELECT 1 FROM reminder_schedule WHERE reminder_id = $1', [reminderId])).toBeNull();
    expect((await new Client().req('POST', '/api/push/action', { token: tokens.done!.replace(/.$/, 'x') })).status).toBe(401);
  });

  it('wiederkehrende Aufgabe springt weiter, Rotation wechselt', async () => {
    const taskId = uuidv7();
    const today = zonedParts(new Date(), 'Europe/Berlin').date;
    await anna.push([
      {
        type: 'task',
        id: taskId,
        data: {
          projectId: haushalt,
          title: 'Bad putzen (Rotation)',
          dueDate: today,
          recurrence: { freq: 'day', interval: 1 },
          rotation: [annaId, benId],
          assigneeId: annaId,
          createdAt: 'x',
        },
      },
    ]);
    const token = push.signAction(annaId, taskId, 'done');
    sent.length = 0;
    expect((await new Client().req('POST', '/api/push/action', { token })).status).toBe(200);
    const p = await anna.pull();
    const t = obj(p.json, taskId)!.data;
    expect(t.completedAt).toBeNull();
    expect(String(t.dueDate) > today).toBe(true);
    expect(t.assigneeId).toBe(benId);
    expect(sent.find((s) => s.payload.title === 'Du bist dran')).toBeTruthy();
  });

  it('Morgen-Briefing einmal pro Tag', async () => {
    const taskId = uuidv7();
    const now = new Date();
    const local = zonedParts(now, 'Europe/Berlin');
    await anna.push([{ type: 'task', id: taskId, data: { projectId: annaInbox, title: 'Steuer', dueDate: local.date, createdAt: 'x' } }]);
    await anna.req('PATCH', '/api/me', { settings: { briefingTime: local.time, briefingEnabled: true } });
    sent.length = 0;
    expect(await processBriefings(db, push, now)).toBeGreaterThanOrEqual(1);
    expect(sent.some((s) => s.payload.title === 'Guten Morgen!')).toBe(true);
    expect(await processBriefings(db, push, now)).toBe(0);
  });

  it('Projekt löschen löscht Inhalte; Mitglieder bekommen Grabsteine', async () => {
    const cursor = (await ben.pull()).json.cursor;
    const res = await anna.push([{ type: 'project', id: haushalt, op: 'delete' }]);
    expect(res.json.rejected).toEqual([]);
    const p = await ben.pull(cursor);
    expect(p.json.projectIds).not.toContain(haushalt);
    expect(obj(p.json, task1)?.deleted).toBe(true);
    const inboxDelete = await anna.push([{ type: 'project', id: annaInbox, op: 'delete' }]);
    expect(inboxDelete.json.rejected).toHaveLength(1);
  });

  it('Kalender-Abo liefert Termine', async () => {
    const taskId = uuidv7();
    await anna.push([{ type: 'task', id: taskId, data: { projectId: annaInbox, title: 'Arzt; Kontrolle', dueDate: '2030-01-15', dueTime: '09:30', createdAt: 'x' } }]);
    const { json } = await anna.req<{ url: string }>('POST', '/api/me/ical');
    const path = new URL(json.url).pathname;
    const ics = await new Client().req('GET', path);
    expect(ics.status).toBe(200);
    expect(ics.text).toContain('SUMMARY:Arzt\\; Kontrolle');
    expect(ics.text).toContain('DTSTART:20300115T083000Z');
  });

  it('WebSocket stupst bei Änderungen an', async () => {
    const ws = await app.injectWS('/api/sync/ws', { headers: { cookie: anna.cookie, origin: ORIGIN } });
    const messages: string[] = [];
    ws.on('message', (d: Buffer) => messages.push(d.toString()));
    await new Promise((r) => setTimeout(r, 50));
    await anna.push([{ type: 'task', id: uuidv7(), data: { projectId: annaInbox, title: 'Ping', createdAt: 'x' } }]);
    await new Promise((r) => setTimeout(r, 50));
    expect(messages.map((m) => JSON.parse(m).type)).toEqual(['hello', 'poke']);
    ws.terminate();
  });
});
