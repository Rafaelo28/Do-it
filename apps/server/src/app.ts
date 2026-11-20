import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import {
  addDays,
  completeTaskChanges,
  isValidTimeZone,
  pushRequestSchema,
  settingsSchema,
  uuidv7,
  zonedParts,
  type TaskData,
} from '@do-it/shared';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import {
  createSession,
  createUser,
  deleteSession,
  hashPassword,
  newToken,
  normalizeEmail,
  RateLimiter,
  SESSION_COOKIE,
  SESSION_DAYS,
  sha256,
  toMe,
  userForSession,
  verifyPassword,
  type UserRow,
} from './auth';
import type { Config } from './config';
import type { Db } from './db';
import { Hub } from './hub';
import { buildIcs } from './ical';
import { loadKeys, type ServerKeys } from './keys';
import { PushService, webPushTransport, type PushTransport } from './push';
import { rescheduleReminders } from './reminders';
import { isRejection, SyncService } from './sync';

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const emailSchema = z.string().trim().min(3).max(200).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'ungültige E-Mail-Adresse');
const passwordSchema = z.string().min(8, 'mindestens 8 Zeichen').max(200);
const nameSchema = z.string().trim().min(1).max(80);
const tzSchema = z.string().max(64).refine(isValidTimeZone, 'unbekannte Zeitzone');
const uuidParam = z.string().uuid();

export interface AppOptions {
  config: Config;
  db: Db;
  pushTransport?: PushTransport;
  logger?: boolean | object;
}

export async function buildApp({ config, db, pushTransport, logger = false }: AppOptions) {
  const keys: ServerKeys = await loadKeys(db, config);
  const hub = new Hub();
  const push = new PushService(db, keys, pushTransport ?? webPushTransport(keys));
  const sync = new SyncService(db, hub, async (notices) => {
    for (const n of notices) {
      await push.sendToUser(n.userId, {
        title: n.title,
        body: n.body,
        tag: n.taskId,
        url: n.taskId ? `/task/${n.taskId}` : '/',
        taskId: n.taskId,
      });
    }
  });
  const loginLimiter = new RateLimiter(10, 15 * 60_000);
  const inviteLimiter = new RateLimiter(30, 15 * 60_000);

  const app = Fastify({ logger, trustProxy: true, bodyLimit: 2 * 1024 * 1024 });
  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });

  const clientIp = (req: FastifyRequest) => String(req.headers['cf-connecting-ip'] ?? req.ip);

  // Schutz gegen Cross-Site-Anfragen: schreibende API-Aufrufe nur von der eigenen Origin.
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/') || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    const origin = req.headers.origin;
    if (origin && !config.origins.includes(origin)) throw new HttpError(403, 'Fremde Origin');
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      return reply.code(400).send({ error: `${issue?.path.join('.') || 'Eingabe'}: ${issue?.message ?? 'ungültig'}` });
    }
    if (isRejection(err)) return reply.code(403).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    req.log.error(err);
    return reply.code(500).send({ error: 'Interner Fehler' });
  });

  async function currentUser(req: FastifyRequest): Promise<UserRow | null> {
    return userForSession(db, req.cookies[SESSION_COOKIE]);
  }

  async function requireUser(req: FastifyRequest): Promise<UserRow> {
    const user = await currentUser(req);
    if (!user) throw new HttpError(401, 'Nicht angemeldet');
    return user;
  }

  function setSessionCookie(reply: FastifyReply, token: string): void {
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: 'lax',
      maxAge: SESSION_DAYS * 86400,
    });
  }

  async function roleOf(userId: string, projectId: string): Promise<string | null> {
    const row = await db.one<{ role: string }>('SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
    return row?.role ?? null;
  }

  async function projectMembers(projectId: string): Promise<string[]> {
    const rows = await db.query<{ user_id: string }>('SELECT user_id FROM project_members WHERE project_id = $1', [projectId]);
    return rows.map((r) => r.user_id);
  }

  // ---------- Status ----------

  app.get('/api/health', async () => {
    await db.query('SELECT 1');
    const hb = await db.one<{ value: string }>(`SELECT value FROM server_kv WHERE key = 'worker_heartbeat'`);
    const workerAgeSec = hb ? Math.round((Date.now() - new Date(hb.value).getTime()) / 1000) : null;
    return { ok: true, workerAgeSec, connections: hub.connectionCount };
  });

  // ---------- Anmeldung ----------

  app.get('/api/auth/status', async (req) => {
    const count = await db.one<{ n: number }>('SELECT count(*)::int AS n FROM users');
    const user = await currentUser(req);
    return { setupRequired: (count?.n ?? 0) === 0, user: user ? toMe(user) : null };
  });

  app.post('/api/auth/setup', async (req, reply) => {
    const body = z
      .object({ name: nameSchema, email: emailSchema, password: passwordSchema, timezone: tzSchema.default('Europe/Berlin') })
      .parse(req.body);
    const user = await db.tx(async (q) => {
      await q.query('LOCK TABLE users IN EXCLUSIVE MODE');
      const count = await q.one<{ n: number }>('SELECT count(*)::int AS n FROM users');
      if ((count?.n ?? 0) > 0) throw new HttpError(409, 'Die Einrichtung ist bereits abgeschlossen');
      return createUser(q, { ...body, isAdmin: true });
    });
    setSessionCookie(reply, await createSession(db, user.id, req.headers['user-agent']));
    return { user: toMe(user) };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = z.object({ email: z.string().max(200), password: z.string().max(200) }).parse(req.body);
    const email = normalizeEmail(body.email);
    const key = `${clientIp(req)}|${email}`;
    if (!loginLimiter.check(key) || !loginLimiter.check(clientIp(req))) {
      throw new HttpError(429, 'Zu viele Versuche. Bitte in 15 Minuten erneut probieren.');
    }
    const user = await db.one<UserRow>('SELECT * FROM users WHERE email = $1', [email]);
    const ok = user ? await verifyPassword(body.password, user.password_hash) : await hashPassword(body.password).then(() => false);
    if (!user || !ok) throw new HttpError(401, 'E-Mail oder Passwort falsch');
    loginLimiter.reset(key);
    setSessionCookie(reply, await createSession(db, user.id, req.headers['user-agent']));
    return { user: toMe(user) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await deleteSession(db, req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/register', async (req, reply) => {
    if (!inviteLimiter.check(clientIp(req))) throw new HttpError(429, 'Zu viele Versuche');
    const body = z
      .object({ token: z.string().min(10).max(200), name: nameSchema, email: emailSchema, password: passwordSchema, timezone: tzSchema.default('Europe/Berlin') })
      .parse(req.body);
    const user = await db.tx(async (q) => {
      const invite = await q.one<{ id: string; project_id: string | null; role: string }>(
        `SELECT id, project_id, role FROM invites WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
        [sha256(body.token)],
      );
      if (!invite) throw new HttpError(400, 'Einladung ungültig oder abgelaufen');
      const exists = await q.one('SELECT 1 FROM users WHERE email = $1', [normalizeEmail(body.email)]);
      if (exists) throw new HttpError(409, 'Für diese E-Mail gibt es schon ein Konto. Bitte anmelden und Einladung dann annehmen.');
      const u = await createUser(q, { ...body, isAdmin: false });
      if (invite.project_id) {
        await q.query(`INSERT INTO project_members(project_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [
          invite.project_id,
          u.id,
          invite.role,
        ]);
      }
      await q.query('UPDATE invites SET used_at = now(), used_by = $2 WHERE id = $1', [invite.id, u.id]);
      return { u, projectId: invite.project_id };
    });
    if (user.projectId) hub.poke(await projectMembers(user.projectId));
    setSessionCookie(reply, await createSession(db, user.u.id, req.headers['user-agent']));
    return { user: toMe(user.u) };
  });

  // ---------- Eigenes Konto ----------

  app.get('/api/me', async (req) => ({ user: toMe(await requireUser(req)) }));

  app.patch('/api/me', async (req) => {
    const user = await requireUser(req);
    const body = z.object({ name: nameSchema.optional(), timezone: tzSchema.optional(), settings: settingsSchema.partial().optional() }).parse(req.body);
    const updated = await db.tx(async (q) => {
      const u = await q.one<UserRow>(
        `UPDATE users SET name = COALESCE($2, name), timezone = COALESCE($3, timezone), settings = settings || $4::jsonb WHERE id = $1 RETURNING *`,
        [user.id, body.name ?? null, body.timezone ?? null, body.settings ?? {}],
      );
      if (body.timezone || body.settings?.morningTime) {
        const ids = await q.query<{ id: string }>(`SELECT id FROM objects WHERE type = 'reminder' AND owner_id = $1 AND NOT deleted`, [user.id]);
        await rescheduleReminders(q, { taskIds: [], reminderIds: ids.map((r) => r.id) });
      }
      return u!;
    });
    hub.poke([user.id]);
    return { user: toMe(updated) };
  });

  app.post('/api/me/password', async (req) => {
    const user = await requireUser(req);
    const body = z.object({ current: z.string().max(200), next: passwordSchema }).parse(req.body);
    if (!(await verifyPassword(body.current, user.password_hash))) throw new HttpError(400, 'Aktuelles Passwort ist falsch');
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(body.next)]);
    await db.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [user.id, sha256(req.cookies[SESSION_COOKIE] ?? '')]);
    return { ok: true };
  });

  app.post('/api/me/ical', async (req) => {
    const user = await requireUser(req);
    const token = newToken(24);
    await db.query('UPDATE users SET ical_token = $2 WHERE id = $1', [user.id, token]);
    return { url: `${new URL(config.APP_URL).origin}/api/ical/${token}.ics` };
  });

  app.delete('/api/me/ical', async (req) => {
    const user = await requireUser(req);
    await db.query('UPDATE users SET ical_token = NULL WHERE id = $1', [user.id]);
    return { ok: true };
  });

  app.get('/api/ical/:file', async (req, reply) => {
    const { file } = z.object({ file: z.string().regex(/^[\w-]{20,64}\.ics$/) }).parse(req.params);
    const user = await db.one<UserRow>('SELECT * FROM users WHERE ical_token = $1', [file.replace(/\.ics$/, '')]);
    if (!user) throw new HttpError(404, 'Unbekannter Kalender');
    const tasks = await db.query<{ id: string; data: TaskData }>(
      `SELECT t.id, t.data FROM objects t JOIN project_members pm ON pm.project_id = t.project_id AND pm.user_id = $1
       WHERE t.type = 'task' AND NOT t.deleted AND t.data->>'completedAt' IS NULL AND t.data->>'dueDate' IS NOT NULL
         AND (t.data->>'assigneeId' IS NULL OR t.data->>'assigneeId' = $1::text)`,
      [user.id],
    );
    reply.type('text/calendar; charset=utf-8');
    return buildIcs(tasks, user.timezone, config.APP_URL);
  });

  // ---------- Einladungen und Mitglieder ----------

  app.post('/api/invites', async (req) => {
    const user = await requireUser(req);
    const body = z.object({ projectId: uuidParam.optional(), role: z.enum(['editor', 'viewer']).default('editor') }).parse(req.body ?? {});
    if (body.projectId) {
      if ((await roleOf(user.id, body.projectId)) !== 'owner') throw new HttpError(403, 'Nur Besitzer können einladen');
      const p = await db.one<{ data: { isInbox?: boolean } }>(`SELECT data FROM objects WHERE id = $1 AND type = 'project' AND NOT deleted`, [body.projectId]);
      if (!p || p.data.isInbox) throw new HttpError(400, 'Dieses Projekt kann nicht geteilt werden');
    } else if (!user.is_admin) {
      throw new HttpError(403, 'Nur Admins können neue Konten einladen');
    }
    const token = newToken(24);
    const expires = new Date(Date.now() + 7 * 86400_000);
    await db.query('INSERT INTO invites(id, token_hash, created_by, project_id, role, expires_at) VALUES ($1, $2, $3, $4, $5, $6)', [
      uuidv7(),
      sha256(token),
      user.id,
      body.projectId ?? null,
      body.role,
      expires,
    ]);
    return { token, url: `${new URL(config.APP_URL).origin}/invite/${token}`, expiresAt: expires.toISOString() };
  });

  app.get('/api/invites/:token', async (req) => {
    if (!inviteLimiter.check(clientIp(req))) throw new HttpError(429, 'Zu viele Versuche');
    const { token } = z.object({ token: z.string().max(200) }).parse(req.params);
    const row = await db.one<{ project_id: string | null; inviter: string; project: { name?: string } | null; role: string }>(
      `SELECT i.project_id, i.role, u.name AS inviter, p.data AS project FROM invites i
       JOIN users u ON u.id = i.created_by LEFT JOIN objects p ON p.id = i.project_id
       WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > now()`,
      [sha256(token)],
    );
    if (!row) return { valid: false };
    return { valid: true, invitedBy: row.inviter, projectName: row.project?.name ?? null, role: row.role };
  });

  app.post('/api/invites/:token/accept', async (req) => {
    const user = await requireUser(req);
    const { token } = z.object({ token: z.string().max(200) }).parse(req.params);
    const projectId = await db.tx(async (q) => {
      const invite = await q.one<{ id: string; project_id: string | null; role: string }>(
        'SELECT id, project_id, role FROM invites WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE',
        [sha256(token)],
      );
      if (!invite?.project_id) throw new HttpError(400, 'Einladung ungültig oder abgelaufen');
      await q.query('INSERT INTO project_members(project_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [
        invite.project_id,
        user.id,
        invite.role,
      ]);
      await q.query('UPDATE invites SET used_at = now(), used_by = $2 WHERE id = $1', [invite.id, user.id]);
      return invite.project_id;
    });
    hub.poke(await projectMembers(projectId));
    return { projectId };
  });

  app.get('/api/projects/:id/members', async (req) => {
    const user = await requireUser(req);
    const { id } = z.object({ id: uuidParam }).parse(req.params);
    if (!(await roleOf(user.id, id))) throw new HttpError(404, 'Projekt nicht gefunden');
    const rows = await db.query<{ user_id: string; name: string; email: string; role: string }>(
      'SELECT pm.user_id, u.name, u.email, pm.role FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = $1 ORDER BY pm.created_at',
      [id],
    );
    return { members: rows.map((r) => ({ userId: r.user_id, name: r.name, email: r.email, role: r.role })) };
  });

  app.patch('/api/projects/:id/members/:userId', async (req) => {
    const user = await requireUser(req);
    const { id, userId } = z.object({ id: uuidParam, userId: uuidParam }).parse(req.params);
    const { role } = z.object({ role: z.enum(['owner', 'editor', 'viewer']) }).parse(req.body);
    if ((await roleOf(user.id, id)) !== 'owner') throw new HttpError(403, 'Nur Besitzer können Rollen ändern');
    await db.tx(async (q) => {
      await q.query('UPDATE project_members SET role = $3 WHERE project_id = $1 AND user_id = $2', [id, userId, role]);
      const owners = await q.one<{ n: number }>(`SELECT count(*)::int AS n FROM project_members WHERE project_id = $1 AND role = 'owner'`, [id]);
      if (!owners?.n) throw new HttpError(400, 'Ein Projekt braucht mindestens einen Besitzer');
    });
    hub.poke(await projectMembers(id));
    return { ok: true };
  });

  app.delete('/api/projects/:id/members/:userId', async (req) => {
    const user = await requireUser(req);
    const { id, userId } = z.object({ id: uuidParam, userId: uuidParam }).parse(req.params);
    const myRole = await roleOf(user.id, id);
    if (userId !== user.id && myRole !== 'owner') throw new HttpError(403, 'Nur Besitzer können Mitglieder entfernen');
    const members = await projectMembers(id);
    await db.tx(async (q) => {
      const p = await q.one<{ data: { isInbox?: boolean } }>(`SELECT data FROM objects WHERE id = $1`, [id]);
      if (p?.data.isInbox) throw new HttpError(400, 'Den Eingang kann man nicht verlassen');
      await q.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [id, userId]);
      const owners = await q.one<{ n: number }>(`SELECT count(*)::int AS n FROM project_members WHERE project_id = $1 AND role = 'owner'`, [id]);
      if (!owners?.n) throw new HttpError(400, 'Ein Projekt braucht mindestens einen Besitzer');
    });
    hub.poke(members);
    return { ok: true };
  });

  app.get('/api/projects/:id/activity', async (req) => {
    const user = await requireUser(req);
    const { id } = z.object({ id: uuidParam }).parse(req.params);
    if (!(await roleOf(user.id, id))) throw new HttpError(404, 'Projekt nicht gefunden');
    const rows = await db.query<{ id: number; summary: string; created_at: Date; object_id: string | null; kind: string }>(
      'SELECT id, summary, created_at, object_id, kind FROM activity WHERE project_id = $1 ORDER BY id DESC LIMIT 100',
      [id],
    );
    return { activity: rows.map((r) => ({ id: r.id, summary: r.summary, at: r.created_at, objectId: r.object_id, kind: r.kind })) };
  });

  // ---------- Synchronisierung ----------

  app.get('/api/sync/pull', async (req) => {
    const user = await requireUser(req);
    const q = z.object({ cursor: z.coerce.number().int().min(0).default(0), project: uuidParam.optional() }).parse(req.query);
    return sync.pull(user, q.cursor, q.project);
  });

  app.post('/api/sync/push', async (req) => {
    const user = await requireUser(req);
    const body = pushRequestSchema.parse(req.body);
    return sync.push(user, body.mutations);
  });

  app.get('/api/sync/ws', { websocket: true }, async (socket, req) => {
    const origin = req.headers.origin;
    const user = origin && !config.origins.includes(origin) ? null : await currentUser(req);
    if (!user) {
      socket.close(4401, 'unauthorized');
      return;
    }
    hub.add(user.id, socket);
    socket.on('close', () => hub.remove(user.id, socket));
    socket.on('error', () => hub.remove(user.id, socket));
  });

  // ---------- Push ----------

  app.get('/api/push/key', async () => ({ publicKey: keys.vapidPublic }));

  const subscriptionSchema = z.object({
    endpoint: z.string().url().max(1000),
    keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
  });

  app.post('/api/push/subscription', async (req) => {
    const user = await requireUser(req);
    await push.subscribe(user.id, subscriptionSchema.parse(req.body), req.headers['user-agent']);
    return { ok: true, devices: await push.deviceCount(user.id) };
  });

  app.delete('/api/push/subscription', async (req) => {
    const user = await requireUser(req);
    const { endpoint } = z.object({ endpoint: z.string().max(1000) }).parse(req.body);
    await push.unsubscribe(user.id, endpoint);
    return { ok: true };
  });

  app.post('/api/push/test', async (req) => {
    const user = await requireUser(req);
    const delivered = await push.sendToUser(user.id, {
      title: 'Do-it funktioniert 🎉',
      body: 'So sehen deine Erinnerungen aus.',
      tag: 'test',
      url: '/settings',
    });
    return { delivered };
  });

  app.post('/api/push/action', async (req) => {
    const { token } = z.object({ token: z.string().max(500) }).parse(req.body);
    const v = push.verifyAction(token);
    if (!v) throw new HttpError(401, 'Aktion abgelaufen');
    const user = await db.one<UserRow>('SELECT * FROM users WHERE id = $1', [v.userId]);
    const task = await db.one<{ data: TaskData }>(`SELECT data FROM objects WHERE id = $1 AND type = 'task' AND NOT deleted`, [v.taskId]);
    if (!user || !task) throw new HttpError(404, 'Aufgabe nicht gefunden');
    const local = zonedParts(new Date(), user.timezone);
    let res;
    if (v.action === 'done') {
      const changes = completeTaskChanges(task.data, local.date, user.id, new Date().toISOString());
      res = await sync.applyAs(user, [{ type: 'task', id: v.taskId, op: 'put', data: changes }]);
    } else if (v.action === 'tomorrow') {
      res = await sync.applyAs(user, [{ type: 'task', id: v.taskId, op: 'put', data: { dueDate: addDays(local.date, 1) } }]);
    } else if (v.action === 'snooze') {
      const at = zonedParts(new Date(Date.now() + 60 * 60_000), user.timezone);
      res = await sync.applyAs(user, [
        { type: 'reminder', id: uuidv7(), op: 'put', data: { taskId: v.taskId, kind: 'absolute', offsetMin: null, date: at.date, time: at.time } },
      ]);
    } else throw new HttpError(400, 'Unbekannte Aktion');
    if (res.rejected.length) throw new HttpError(403, res.rejected[0]!.reason);
    return { ok: true };
  });

  // ---------- PWA ausliefern ----------

  const webDist = config.WEB_DIST ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (existsSync(resolve(webDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      index: false,
      wildcard: true,
      setHeaders(res, filePath) {
        if (filePath.includes('/assets/')) res.header('Cache-Control', 'public, max-age=31536000, immutable');
        else if (/(sw\.js|workbox-[\w-]+\.js|manifest\.webmanifest|index\.html)$/.test(filePath)) res.header('Cache-Control', 'no-cache');
        else res.header('Cache-Control', 'public, max-age=3600');
      },
    });
    const sendIndex = (reply: FastifyReply) =>
      reply
        .header('Cache-Control', 'no-cache')
        .header(
          'Content-Security-Policy',
          "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
        )
        .sendFile('index.html');
    app.get('/', (req, reply) => sendIndex(reply));
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || (req.method !== 'GET' && req.method !== 'HEAD')) return reply.code(404).send({ error: 'Nicht gefunden' });
      return sendIndex(reply);
    });
  } else {
    app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: 'Nicht gefunden' }));
  }

  return { app, hub, sync, push, keys };
}

