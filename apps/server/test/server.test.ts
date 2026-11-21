import { randomUUID } from 'node:crypto';
import { completeTaskChanges, formatHlc, uuidv7, zonedParts, zonedToUtc, type KarmaSummary, type Mutation, type PullResponse, type SyncObject, type TaskData } from '@do-it/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createDb, type Db } from '../src/db';
import { migrate } from '../src/migrations';
import type { PushService } from '../src/push';
import { processBriefings, processDueReminders } from '../src/reminders';
import { currentStep, totpAt } from '../src/totp';

const BASE = process.env.TEST_DATABASE_URL ?? 'postgres://doit:doit@localhost:5432/doit';
const ORIGIN = 'http://localhost:8080';
const SETUP_CODE = 'TEST-CODE-1';

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
  const config = loadConfig({ DATABASE_URL: url.toString(), APP_URL: ORIGIN, SETUP_CODE } as NodeJS.ProcessEnv);
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
    const form = { name: 'Anna', email: 'Anna@Example.org', password: 'geheim1234', timezone: 'Europe/Berlin' };
    // ohne oder mit falschem Einrichtungscode kann niemand das Admin-Konto anlegen
    expect((await anna.req('POST', '/api/auth/setup', form)).status).toBe(403);
    expect((await anna.req('POST', '/api/auth/setup', { ...form, setupCode: 'FALSCH-00' })).status).toBe(403);
    // zu bekannte Passwörter werden abgelehnt
    expect((await anna.req('POST', '/api/auth/setup', { ...form, password: 'passwort123', setupCode: SETUP_CODE })).status).toBe(400);
    const res = await anna.req<{ user: { id: string; isAdmin: boolean; twoFactor: boolean } }>('POST', '/api/auth/setup', {
      ...form,
      setupCode: 'test code 1', // Groß-/Kleinschreibung und Trennzeichen egal
    });
    expect(res.status).toBe(200);
    expect(res.json.user.isAdmin).toBe(true);
    expect(res.json.user.twoFactor).toBe(false);
    annaId = res.json.user.id;
    const again = await new Client().req('POST', '/api/auth/setup', { name: 'X', email: 'x@example.org', password: 'geheim1234', setupCode: SETUP_CODE });
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
      password: 'ben-geheim-42',
    });
    expect(reg.status).toBe(200);
    benId = reg.json.user.id;
    const reuse = await new Client().req('POST', '/api/auth/register', { token: invite.json.token, name: 'C', email: 'c@example.org', password: 'c-geheim-42' });
    expect(reuse.status).toBe(400);
    expect(reuse.text).toContain('Einladung');

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

  it('Sicherheits-Header', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(String(res.headers['permissions-policy'])).toContain('camera=()');
    expect(res.headers['cache-control']).toBe('no-store');
    // HSTS nur über HTTPS
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('Erledigt-Übersicht listet abgeschlossene Aufgaben', async () => {
    const res = await anna.req<{ items: { title: string; byName: string; stillDone: boolean; recurring: boolean }[] }>('GET', '/api/completed?days=7');
    expect(res.status).toBe(200);
    expect(res.json.items.find((i) => i.title === 'Zahnarzt anrufen')).toMatchObject({ byName: 'Anna', stillDone: true, recurring: false });
    expect(res.json.items.find((i) => i.title === 'Bad putzen (Rotation)')).toMatchObject({ recurring: true });
    expect((await anna.req('GET', '/api/completed?days=0')).status).toBe(400);
    expect((await new Client().req('GET', '/api/completed')).status).toBe(401);
  });

  it('Sitzungen anzeigen und andere Geräte abmelden', async () => {
    const phone = new Client();
    expect((await phone.req('POST', '/api/auth/login', { email: 'ben@example.org', password: 'ben-geheim-42' })).status).toBe(200);
    const list = await ben.req<{ sessions: { device: string; current: boolean }[] }>('GET', '/api/me/sessions');
    expect(list.json.sessions.length).toBeGreaterThanOrEqual(2);
    expect(list.json.sessions.filter((s) => s.current)).toHaveLength(1);
    const out = await ben.req<{ removed: number }>('POST', '/api/me/sessions/logout-others');
    expect(out.json.removed).toBeGreaterThanOrEqual(1);
    expect((await phone.req('GET', '/api/me')).status).toBe(401);
    expect((await ben.req('GET', '/api/me')).status).toBe(200);
  });

  it('Zwei-Faktor-Anmeldung: einrichten, anmelden, Wiederherstellungscode, ausschalten', async () => {
    const other = new Client();
    expect((await other.req('POST', '/api/auth/login', { email: 'ben@example.org', password: 'ben-geheim-42' })).status).toBe(200);

    const setup = await ben.req<{ secret: string; uri: string; qr: string }>('POST', '/api/me/2fa/setup');
    expect(setup.status).toBe(200);
    expect(setup.json.uri).toMatch(/^otpauth:\/\/totp\/Do-it:ben%40example\.org\?secret=/);
    expect(setup.json.qr).toContain('<svg');
    const secret = setup.json.secret.replace(/\s/g, '');
    const step = currentStep();

    expect((await ben.req('POST', '/api/me/2fa/enable', { code: '000000' })).status).toBe(400);
    const enable = await ben.req<{ recoveryCodes: string[] }>('POST', '/api/me/2fa/enable', { code: totpAt(secret, step) });
    expect(enable.status).toBe(200);
    expect(enable.json.recoveryCodes).toHaveLength(8);
    expect((await ben.req<{ user: { twoFactor: boolean } }>('GET', '/api/me')).json.user.twoFactor).toBe(true);
    // andere Geräte müssen sich neu anmelden
    expect((await other.req('GET', '/api/me')).status).toBe(401);

    const login = (code?: string) =>
      new Client().req<{ twoFactorRequired?: boolean; error?: string }>('POST', '/api/auth/login', { email: 'ben@example.org', password: 'ben-geheim-42', code });
    const noCode = await login();
    expect(noCode.status).toBe(401);
    expect(noCode.json.twoFactorRequired).toBe(true);
    expect((await login('123456')).status).toBe(401);
    // der Code der Einrichtung ist verbraucht, der nächste gilt
    expect((await login(totpAt(secret, step))).status).toBe(401);
    expect((await login(totpAt(secret, step + 1))).status).toBe(200);
    expect((await login(totpAt(secret, step + 1))).status).toBe(401);

    // Wiederherstellungscode genau einmal
    const recovery = enable.json.recoveryCodes[0]!;
    expect((await login(recovery.toUpperCase())).status).toBe(200);
    expect((await login(recovery)).status).toBe(401);

    // ausschalten braucht Passwort und Code
    expect((await ben.req('POST', '/api/me/2fa/disable', { password: 'falsch', code: enable.json.recoveryCodes[1] })).status).toBe(400);
    expect((await ben.req('POST', '/api/me/2fa/disable', { password: 'ben-geheim-42', code: enable.json.recoveryCodes[1] })).status).toBe(200);
    expect((await login()).status).toBe(200);
    expect((await ben.req<{ user: { twoFactor: boolean } }>('GET', '/api/me')).json.user.twoFactor).toBe(false);
  });

  it('über HTTPS: __Host-Cookie, HSTS und altes Cookie gilt weiter', async () => {
    const httpsOrigin = 'https://do-it.example';
    const secure = await buildApp({
      config: loadConfig({ DATABASE_URL: 'postgres://unused', APP_URL: httpsOrigin } as NodeJS.ProcessEnv),
      db,
    });
    try {
      const res = await secure.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'anna@example.org', password: 'geheim1234' },
        headers: { origin: httpsOrigin },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['strict-transport-security']).toContain('max-age=');
      const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
      const host = cookies.find((c) => c.startsWith('__Host-doit_session='))!;
      expect(host).toMatch(/; Path=\//);
      expect(host).toMatch(/; HttpOnly/);
      expect(host).toMatch(/; Secure/);
      expect(host).not.toMatch(/Domain=/i);
      const token = host.split(';')[0]!.split('=')[1]!;
      const viaHost = await secure.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `__Host-doit_session=${token}` } });
      expect(viaHost.statusCode).toBe(200);
      const viaLegacy = await secure.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `doit_session=${token}` } });
      expect(viaLegacy.statusCode).toBe(200);
    } finally {
      await secure.app.close();
    }
  });

  it('Karma: Punkte, Tages- und Wochenziel, Rückgängig, neue Stufe', async () => {
    const karma = async () => (await anna.req<KarmaSummary>('GET', '/api/karma')).json;
    const k0 = await karma();
    expect(k0.level.name).toBeTruthy();
    // Ziele so legen, dass sie in diesem Test genau erreicht werden
    await anna.req('PATCH', '/api/me', { settings: { dailyGoal: k0.today.done + 3, weeklyGoal: k0.week.done + 4 } });
    const today = zonedParts(new Date(), 'Europe/Berlin').date;
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    const [t1, t2, t3, t4] = [uuidv7(), uuidv7(), uuidv7(), uuidv7()];
    await anna.push([
      { type: 'task', id: t1, data: { projectId: annaInbox, title: 'Wichtig heute', priority: 1, dueDate: today, createdAt: 'x' } },
      { type: 'task', id: t2, data: { projectId: annaInbox, title: 'Irgendwann', createdAt: 'x' } },
      { type: 'task', id: t3, data: { projectId: annaInbox, parentId: t2, title: 'Teil davon', createdAt: 'x' } },
      { type: 'task', id: t4, data: { projectId: annaInbox, title: 'Überfällig', priority: 2, dueDate: yesterday, createdAt: 'x' } },
    ]);
    const done = (id: string) => anna.push([{ type: 'task', id, data: { completedAt: new Date().toISOString(), completedBy: annaId } }]);
    const reopen = (id: string) => anna.push([{ type: 'task', id, data: { completedAt: null, completedBy: null } }]);

    await done(t1); // 2 + P1 3 + pünktlich 1
    expect((await karma()).points - k0.points).toBe(6);
    await reopen(t1);
    expect((await karma()).points).toBe(k0.points);
    await done(t1);
    await done(t2); // 2
    sent.length = 0;
    await done(t3); // Unteraufgabe 1 + Tagesziel 5
    let k = await karma();
    expect(k.points - k0.points).toBe(6 + 2 + 1 + 5);
    expect(k.today).toMatchObject({ reached: true, done: k0.today.done + 3 });
    expect(k.recent[0]).toMatchObject({ kind: 'daily_goal', points: 5 });
    await done(t4); // 2 + P2 2, nicht pünktlich + Wochenziel 20
    k = await karma();
    expect(k.points - k0.points).toBe(14 + 4 + 20);
    expect(k.week.reached).toBe(true);
    if (k0.points < 30 && k.points >= 30) expect(sent.some((s) => s.payload.title === 'Neue Karma-Stufe: Keimling')).toBe(true);
    // Wieder öffnen nimmt Punkte und weggefallene Ziel-Boni zurück
    await reopen(t3); // Wochenziel fällt weg, Tagesziel bleibt (t4 zählt noch)
    k = await karma();
    expect(k.points - k0.points).toBe(38 - 1 - 20);
    expect(k.week.reached).toBe(false);
    expect(k.today.reached).toBe(true);
    await reopen(t4); // jetzt fällt auch das Tagesziel weg
    k = await karma();
    expect(k.points - k0.points).toBe(17 - 4 - 5);
    expect(k.today.reached).toBe(false);
    expect(k.days).toHaveLength(28);
    expect(k.days.at(-1)!.date).toBe(today);

    // Wiederkehrend: Rückgängig zählt nicht doppelt und verschwindet aus "Erledigt"
    const r = uuidv7();
    await anna.push([{ type: 'task', id: r, data: { projectId: annaInbox, title: 'Gießen', dueDate: today, recurrence: { freq: 'day', interval: 1 }, createdAt: 'x' } }]);
    const before = (await karma()).points;
    const task = obj((await anna.pull()).json, r)!.data as unknown as TaskData;
    const changes = completeTaskChanges(task, today, annaId, new Date().toISOString());
    await anna.push([{ type: 'task', id: r, data: changes as Record<string, unknown> }]);
    expect((await karma()).points - before).toBe(3 + 5); // 2 + pünktlich 1, erreicht wieder das Tagesziel
    await anna.push([{ type: 'task', id: r, data: { dueDate: today, lastCompletedAt: null, lastCompletedBy: null } }]);
    expect((await karma()).points).toBe(before);
    const list = await anna.req<{ items: { taskId: string }[] }>('GET', '/api/completed?days=1');
    expect(list.json.items.some((i) => i.taskId === r)).toBe(false);
  });

  it('Profilbild: hochladen, nur für Mitglieder sichtbar, löschen', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    expect((await anna.req('PUT', '/api/me/avatar', { image: `data:image/svg+xml;base64,${png}` })).status).toBe(400);
    expect((await anna.req('PUT', '/api/me/avatar', { image: `data:image/jpeg;base64,${png}` })).status).toBe(400);
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(310_000)]).toString('base64');
    expect((await anna.req('PUT', '/api/me/avatar', { image: `data:image/jpeg;base64,${big}` })).status).toBe(413);

    const up = await anna.req<{ user: { avatar: string } }>('PUT', '/api/me/avatar', { image: `data:image/png;base64,${png}` });
    expect(up.status).toBe(200);
    expect(up.json.user.avatar).toMatch(new RegExp(`^/api/avatars/${annaId}\\?v=\\d+$`));
    const own = await app.inject({ method: 'GET', url: up.json.user.avatar, headers: { cookie: anna.cookie } });
    expect(own.statusCode).toBe(200);
    expect(own.headers['content-type']).toBe('image/png');
    expect(String(own.headers['cache-control'])).toContain('immutable');
    expect(own.rawPayload.equals(Buffer.from(png, 'base64'))).toBe(true);

    // Ben teilt (wieder) ein Projekt mit Anna und sieht das Bild, Fremde nicht
    const shared = uuidv7();
    await anna.push([{ type: 'project', id: shared, data: { name: 'Gemeinsam', sortKey: 'b0' } }]);
    const inv = await anna.req<{ token: string }>('POST', '/api/invites', { projectId: shared });
    await ben.req('POST', `/api/invites/${inv.json.token}/accept`);
    const benView = await app.inject({ method: 'GET', url: up.json.user.avatar, headers: { cookie: ben.cookie } });
    expect(benView.statusCode).toBe(200);
    expect((await ben.pull()).json.members.find((m) => m.userId === annaId)?.avatar).toBe(up.json.user.avatar);
    const acc = await anna.req<{ token: string }>('POST', '/api/invites', {});
    const clara = new Client();
    await clara.req('POST', '/api/auth/register', { token: acc.json.token, name: 'Clara', email: 'clara@example.org', password: 'clara-geheim-1' });
    expect((await app.inject({ method: 'GET', url: up.json.user.avatar, headers: { cookie: clara.cookie } })).statusCode).toBe(404);
    expect((await new Client().req('GET', up.json.user.avatar)).status).toBe(401);

    const del = await anna.req<{ user: { avatar: string | null } }>('DELETE', '/api/me/avatar');
    expect(del.json.user.avatar).toBeNull();
    expect((await app.inject({ method: 'GET', url: up.json.user.avatar, headers: { cookie: anna.cookie } })).statusCode).toBe(404);
  });

  it('Ansichten und eigene Filter werden in den Einstellungen gespeichert', async () => {
    const id = uuidv7();
    const ok = await anna.req<{ user: { settings: { views: Record<string, unknown>; filters: unknown[] } } }>('PATCH', '/api/me', {
      settings: {
        views: { [`project:${annaInbox}`]: { layout: 'board', group: 'priority' }, calendar: { cal: 'month' } },
        filters: [{ id, name: 'Wichtig', query: '(heute | überfällig) & p1', color: '#e5484d' }],
      },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.user.settings.views.calendar).toEqual({ cal: 'month' });
    expect(ok.json.user.settings.filters).toHaveLength(1);
    expect((await anna.req('PATCH', '/api/me', { settings: { views: { x: { layout: 'gantt' } } } })).status).toBe(400);
    const look = { mode: 'dark', accent: '#8e4ec6', style: 'cool', density: 'compact', radius: 'soft', textSize: 'large' };
    const saved = await anna.req<{ user: { settings: { appearance: unknown } } }>('PATCH', '/api/me', { settings: { appearance: look } });
    expect(saved.json.user.settings.appearance).toEqual(look);
    expect((await anna.req('PATCH', '/api/me', { settings: { appearance: { ...look, accent: 'lila' } } })).status).toBe(400);
    expect((await anna.req('PATCH', '/api/me', { settings: { appearance: { ...look, style: 'neon' } } })).status).toBe(400);
    expect((await anna.req('PATCH', '/api/me', { settings: { filters: [{ id: 'kein-uuid', name: 'X', query: 'heute', color: null }] } })).status).toBe(400);
    // Kalender-Abo enthält Deadlines
    await anna.push([{ type: 'task', id: uuidv7(), data: { projectId: annaInbox, title: 'Abgabe Bericht', deadline: '2030-02-01', createdAt: 'x' } }]);
    const { json } = await anna.req<{ url: string }>('POST', '/api/me/ical');
    const ics = await new Client().req('GET', new URL(json.url).pathname);
    expect(ics.text).toContain('SUMMARY:Deadline: Abgabe Bericht');
    expect(ics.text).toContain('DTSTART;VALUE=DATE:20300201');
  });

  it('Termine: kein Karma, Erinnerung an jeden Termin, Briefing und Kalender-Abo', async () => {
    const id = uuidv7();
    const rem = uuidv7();
    const local = zonedParts(new Date(Date.now() - 2 * 86400_000), 'Europe/Berlin');
    // wöchentlich wiederkehrender Termin, der erste lag vor zwei Tagen
    await anna.push([
      { type: 'task', id, data: { projectId: annaInbox, title: 'Chorprobe', isEvent: true, dueDate: local.date, dueTime: '19:00', durationMin: 90, recurrence: { freq: 'day', interval: 7 }, createdAt: 'x' } },
      { type: 'reminder', id: rem, data: { taskId: id, kind: 'relative', offsetMin: 60 } },
    ]);
    const sched = await db.one<{ fire_at: Date }>('SELECT fire_at FROM reminder_schedule WHERE reminder_id = $1', [rem]);
    const next = zonedToUtc(new Date(new Date(`${local.date}T12:00:00Z`).getTime() + 7 * 86400_000).toISOString().slice(0, 10), '18:00', 'Europe/Berlin');
    expect(new Date(sched!.fire_at).getTime()).toBe(next.getTime());
    // Erinnerung kommt ohne Erledigt-Knöpfe, danach ist der nächste Termin geplant
    sent.length = 0;
    expect((await processDueReminders(db, push, new Date(next.getTime() + 1000))).sent).toBe(1);
    const msg = sent.find((s) => s.payload.title === 'Chorprobe')!;
    expect(String(msg.payload.body)).toMatch(/^Termin · /);
    expect(msg.payload.tokens).toBeUndefined();
    const again = await db.one<{ fire_at: Date; sent_at: Date | null }>('SELECT fire_at, sent_at FROM reminder_schedule WHERE reminder_id = $1', [rem]);
    expect(new Date(again!.fire_at).getTime()).toBe(next.getTime() + 7 * 86400_000);
    expect(again!.sent_at).toBeNull();
    // Termine zählen nicht fürs Karma
    const k = (await anna.req<KarmaSummary>('GET', '/api/karma')).json.points;
    await anna.push([{ type: 'task', id, data: { completedAt: new Date().toISOString() } }]);
    expect((await anna.req<KarmaSummary>('GET', '/api/karma')).json.points).toBe(k);
    await anna.push([{ type: 'task', id, data: { completedAt: null } }]);
    // Kalender-Abo mit Wiederholung
    const { json } = await anna.req<{ url: string }>('POST', '/api/me/ical');
    const ics = await new Client().req('GET', new URL(json.url).pathname);
    expect(ics.text).toMatch(/SUMMARY:Chorprobe[\s\S]*?RRULE:FREQ=DAILY;INTERVAL=7/);
  });
});
