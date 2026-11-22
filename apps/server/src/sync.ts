import {
  formatHlc,
  HybridClock,
  OBJECT_DEFAULTS,
  parseHlc,
  PRIVATE_TYPES,
  uuidv7,
  type MemberInfo,
  type Mutation,
  type ObjectType,
  type PullResponse,
  type PushResponse,
  type Role,
  type SyncObject,
  type TaskData,
} from '@do-it/shared';
import { OBJECT_SCHEMAS } from '@do-it/shared/schemas';
import { avatarUrl, toMe, type UserRow } from './auth';
import { recordCompletion, revokeCompletion } from './karma';
import { lockObjects, type Db, type Queryable } from './db';
import type { Hub } from './hub';
import { rescheduleReminders } from './reminders';

interface ObjectRow {
  id: string;
  type: ObjectType;
  project_id: string | null;
  owner_id: string | null;
  data: Record<string, unknown>;
  clock: Record<string, string>;
  deleted: boolean;
  seq: number;
}

export interface Notice {
  userId: string;
  title: string;
  body: string;
  taskId?: string;
}

export interface Effects {
  projects: Set<string>;
  users: Set<string>;
  taskIds: Set<string>;
  reminderIds: Set<string>;
  notices: Notice[];
}

class Rejection extends Error {}

/** Felder, die nach dem Anlegen nicht mehr geändert werden dürfen. */
const IMMUTABLE: Partial<Record<ObjectType, string[]>> = {
  project: ['isInbox'],
  task: ['createdBy', 'createdAt'],
  reminder: ['taskId'],
  comment: ['taskId', 'authorId', 'createdAt'],
  note: ['createdBy', 'createdAt'],
};

const PULL_LIMIT = 500;

export class SyncService {
  private readonly clock = new HybridClock('server');

  constructor(
    private readonly db: Db,
    private readonly hub: Hub,
    private readonly notify: (notices: Notice[]) => Promise<void>,
  ) {}

  // ---------- Pull ----------

  async pull(user: UserRow, cursor: number, projectId?: string): Promise<PullResponse> {
    const projects = await this.db.query<{ project_id: string }>(
      `SELECT pm.project_id FROM project_members pm
       JOIN objects o ON o.id = pm.project_id AND o.type = 'project' AND NOT o.deleted
       WHERE pm.user_id = $1`,
      [user.id],
    );
    const projectIds = projects.map((p) => p.project_id);

    let rows: ObjectRow[];
    let next = cursor;
    let hasMore = false;
    if (projectId) {
      if (!projectIds.includes(projectId)) throw new Rejection('Kein Zugriff auf dieses Projekt');
      rows = await this.db.query<ObjectRow>(
        `SELECT * FROM objects WHERE project_id = $1 AND owner_id IS NULL AND NOT deleted ORDER BY seq`,
        [projectId],
      );
    } else {
      rows = await this.db.query<ObjectRow>(
        `SELECT * FROM objects
         WHERE seq > $2 ${cursor === 0 ? 'AND NOT deleted' : ''}
           AND (owner_id = $1 OR (owner_id IS NULL AND project_id IN (SELECT project_id FROM project_members WHERE user_id = $1)))
         ORDER BY seq LIMIT ${PULL_LIMIT}`,
        [user.id, cursor],
      );
      hasMore = rows.length === PULL_LIMIT;
      if (rows.length) next = rows[rows.length - 1]!.seq;
      else if (cursor === 0) {
        const max = await this.db.one<{ seq: number | null }>('SELECT max(seq) AS seq FROM objects');
        next = max?.seq ?? 0;
      }
    }

    const members = await this.db.query<{ project_id: string; user_id: string; role: Role; name: string; avatar_at: Date | null }>(
      `SELECT pm.project_id, pm.user_id, pm.role, u.name, u.avatar_at FROM project_members pm JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = ANY($1::uuid[]) ORDER BY u.name`,
      [projectIds],
    );

    const briefing = await this.db.one<{ at: Date | null }>('SELECT max(created_at) AS at FROM briefings WHERE user_id = $1', [user.id]);
    return {
      objects: rows.map(toSyncObject),
      cursor: next,
      hasMore,
      projectIds,
      members: members.map<MemberInfo>((m) => ({ projectId: m.project_id, userId: m.user_id, role: m.role, name: m.name, avatar: avatarUrl(m.user_id, m.avatar_at) })),
      me: toMe(user),
      briefingAt: briefing?.at ? new Date(briefing.at).toISOString() : null,
    };
  }

  // ---------- Push ----------

  async push(user: UserRow, mutations: Mutation[]): Promise<PushResponse> {
    const result: PushResponse = { applied: [], rejected: [] };
    const effects = newEffects();
    await this.db.tx(async (q) => {
      await lockObjects(q);
      const roles = new Map<string, Role | null>();
      for (const m of mutations) {
        await q.query('SAVEPOINT m');
        try {
          const done = await q.one('SELECT 1 FROM applied_mutations WHERE mid = $1', [m.mid]);
          if (!done) {
            await this.apply(q, user, m, effects, roles);
            await q.query('INSERT INTO applied_mutations(mid, user_id) VALUES ($1, $2)', [m.mid, user.id]);
          }
          await q.query('RELEASE SAVEPOINT m');
          result.applied.push(m.mid);
        } catch (err) {
          await q.query('ROLLBACK TO SAVEPOINT m');
          if (!(err instanceof Rejection)) throw err;
          result.rejected.push({ mid: m.mid, reason: err.message });
        }
      }
      await rescheduleReminders(q, { taskIds: [...effects.taskIds], reminderIds: [...effects.reminderIds] });
    });
    await this.afterCommit(effects);
    return result;
  }

  /** Änderung im Namen eines Nutzers vom Server aus (z. B. "Erledigt" aus einer Benachrichtigung). */
  async applyAs(user: UserRow, changes: Omit<Mutation, 'mid' | 'hlc'>[]): Promise<PushResponse> {
    return this.push(
      user,
      changes.map((c) => ({ ...c, mid: `srv-${uuidv7()}`, hlc: this.clock.tick() })),
    );
  }

  private async afterCommit(e: Effects): Promise<void> {
    const users = new Set(e.users);
    if (e.projects.size) {
      const rows = await this.db.query<{ user_id: string }>('SELECT DISTINCT user_id FROM project_members WHERE project_id = ANY($1::uuid[])', [
        [...e.projects],
      ]);
      for (const r of rows) users.add(r.user_id);
    }
    this.hub.poke(users);
    if (e.notices.length) await this.notify(e.notices).catch(() => {});
  }

  private async role(q: Queryable, roles: Map<string, Role | null>, userId: string, projectId: string): Promise<Role | null> {
    if (!roles.has(projectId)) {
      const row = await q.one<{ role: Role }>(
        `SELECT pm.role FROM project_members pm JOIN objects o ON o.id = pm.project_id AND NOT o.deleted
         WHERE pm.project_id = $1 AND pm.user_id = $2`,
        [projectId, userId],
      );
      roles.set(projectId, row?.role ?? null);
    }
    return roles.get(projectId)!;
  }

  private async requireWrite(q: Queryable, roles: Map<string, Role | null>, userId: string, projectId: string): Promise<Role> {
    const role = await this.role(q, roles, userId, projectId);
    if (role !== 'owner' && role !== 'editor') throw new Rejection('Keine Schreibrechte in diesem Projekt');
    return role;
  }

  /** Uhren aus der Zukunft (falsch gestellte Geräte) werden auf Serverzeit gekappt. */
  private normalizeHlc(hlc: string): string {
    const p = parseHlc(hlc);
    if (!p) return this.clock.tick();
    if (p.ms > Date.now() + 60_000) return formatHlc(Date.now(), p.counter, p.node);
    this.clock.receive(hlc);
    return hlc;
  }

  private async apply(q: Queryable, user: UserRow, m: Mutation, e: Effects, roles: Map<string, Role | null>): Promise<void> {
    const hlc = this.normalizeHlc(m.hlc);
    const existing = await q.one<ObjectRow>('SELECT * FROM objects WHERE id = $1 FOR UPDATE', [m.id]);
    if (existing && existing.type !== m.type) throw new Rejection('Typ passt nicht zur ID');

    if (m.op === 'delete') {
      if (!existing || existing.deleted) return;
      await this.checkModify(q, roles, user, existing);
      if (existing.type === 'project' && existing.data.isInbox) throw new Rejection('Der Eingang kann nicht gelöscht werden');
      await q.query(`UPDATE objects SET deleted = true, clock = clock || jsonb_build_object('_deleted', $2::text), seq = nextval('sync_seq'), updated_at = now() WHERE id = $1`, [
        m.id,
        hlc,
      ]);
      await this.cascadeDelete(q, existing, e);
      this.track(e, existing);
      if (existing.type === 'task') {
        await this.activity(q, existing.project_id, user, 'deleted', existing.id, `hat „${String(existing.data.title)}“ gelöscht`);
      }
      return;
    }

    const data = { ...(m.data ?? {}) };
    if (!existing) await this.insert(q, user, m, data, hlc, e, roles);
    else await this.update(q, user, existing, data, hlc, e, roles);
  }

  private async insert(
    q: Queryable,
    user: UserRow,
    m: Mutation,
    data: Record<string, unknown>,
    hlc: string,
    e: Effects,
    roles: Map<string, Role | null>,
  ): Promise<void> {
    const type = m.type;
    const now = new Date().toISOString();
    const full: Record<string, unknown> = { ...OBJECT_DEFAULTS[type], ...data };
    if (type === 'project') full.isInbox = false;
    if (type === 'task') {
      full.createdBy = user.id;
      full.createdAt ??= now;
    }
    if (type === 'comment') {
      full.authorId = user.id;
      full.createdAt = now;
    }
    if (type === 'note') {
      full.createdBy = user.id;
      full.createdAt ??= now;
      full.updatedAt ??= now;
    }
    const parsed = OBJECT_SCHEMAS[type].safeParse(full);
    if (!parsed.success) throw new Rejection(`Ungültige Daten: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
    const value = parsed.data as Record<string, unknown>;

    let projectId: string | null = null;
    let ownerId: string | null = null;
    switch (type) {
      case 'project':
        projectId = m.id;
        break;
      case 'section':
      case 'task':
      case 'note':
        projectId = value.projectId as string;
        await this.requireWrite(q, roles, user.id, projectId);
        if (type === 'task') await this.checkTaskRefs(q, value as unknown as TaskData, projectId);
        break;
      case 'label':
        ownerId = user.id;
        break;
      case 'reminder':
      case 'comment': {
        const task = await q.one<ObjectRow>(`SELECT * FROM objects WHERE id = $1 AND type = 'task' AND NOT deleted`, [value.taskId]);
        if (!task?.project_id || !(await this.role(q, roles, user.id, task.project_id))) throw new Rejection('Aufgabe nicht gefunden');
        projectId = task.project_id;
        if (type === 'reminder') ownerId = user.id;
        else this.commentNotices(task, user, String(value.body), e);
        break;
      }
    }

    const clock = Object.fromEntries(Object.keys(value).map((k) => [k, hlc]));
    await q.query(
      `INSERT INTO objects(id, type, project_id, owner_id, data, clock, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [m.id, type, projectId, ownerId, value, clock, user.id],
    );
    if (type === 'project') {
      await q.query(`INSERT INTO project_members(project_id, user_id, role) VALUES ($1, $2, 'owner')`, [m.id, user.id]);
      roles.set(m.id, 'owner');
      e.users.add(user.id);
    }
    const row: ObjectRow = { id: m.id, type, project_id: projectId, owner_id: ownerId, data: value, clock, deleted: false, seq: 0 };
    this.track(e, row);
    if (type === 'task') {
      const t = value as unknown as TaskData;
      if (t.assigneeId && t.assigneeId !== user.id) {
        e.notices.push({ userId: t.assigneeId, title: 'Neue Aufgabe für dich', body: `${user.name}: ${t.title}`, taskId: m.id });
      }
      await this.activity(q, projectId, user, 'created', m.id, `hat „${t.title}“ angelegt`);
    }
  }

  private async update(
    q: Queryable,
    user: UserRow,
    existing: ObjectRow,
    data: Record<string, unknown>,
    hlc: string,
    e: Effects,
    roles: Map<string, Role | null>,
  ): Promise<void> {
    if (existing.deleted) return;
    await this.checkModify(q, roles, user, existing);
    for (const k of IMMUTABLE[existing.type] ?? []) delete data[k];

    const schema = OBJECT_SCHEMAS[existing.type];
    const partial = schema.partial().safeParse(data);
    if (!partial.success) throw new Rejection(`Ungültige Daten: ${partial.error.issues[0]?.path.join('.')} ${partial.error.issues[0]?.message}`);

    const merged: Record<string, unknown> = { ...existing.data };
    const clock = { ...existing.clock };
    const changed: string[] = [];
    for (const [k, v] of Object.entries(partial.data as Record<string, unknown>)) {
      if (v === undefined) continue;
      if (clock[k] && clock[k]! >= hlc) continue;
      clock[k] = hlc;
      if (JSON.stringify(merged[k]) !== JSON.stringify(v)) {
        merged[k] = v;
        changed.push(k);
      }
    }
    if (!changed.length) {
      await q.query('UPDATE objects SET clock = $2 WHERE id = $1', [existing.id, clock]);
      return;
    }
    const full = schema.safeParse(merged);
    if (!full.success) throw new Rejection(`Ungültige Daten: ${full.error.issues[0]?.message}`);

    let projectId = existing.project_id;
    if ((existing.type === 'task' || existing.type === 'section' || existing.type === 'note') && merged.projectId !== existing.project_id) {
      projectId = merged.projectId as string;
      await this.requireWrite(q, roles, user.id, projectId);
      if (existing.type === 'task') {
        await q.query(
          `UPDATE objects SET project_id = $2, seq = nextval('sync_seq'), updated_at = now()
           WHERE type IN ('reminder', 'comment') AND data->>'taskId' = $1::text`,
          [existing.id, projectId],
        );
        if (existing.project_id) e.projects.add(existing.project_id);
      }
    }

    if (existing.type === 'task' && changed.some((k) => ['assigneeId', 'rotation', 'parentId', 'projectId'].includes(k))) {
      await this.checkTaskRefs(q, merged as unknown as TaskData, projectId!, changed);
    }

    await q.query(`UPDATE objects SET data = $2, clock = $3, project_id = $4, seq = nextval('sync_seq'), updated_at = now() WHERE id = $1`, [
      existing.id,
      merged,
      clock,
      projectId,
    ]);
    const row = { ...existing, data: merged, project_id: projectId };
    this.track(e, row, changed);

    if (existing.type === 'task') {
      const before = existing.data as unknown as TaskData;
      const after = merged as unknown as TaskData;
      // Wiederkehrende Aufgaben: lastCompletedAt rückt vor beim Erledigen, zurück beim Rückgängigmachen
      const recurredNow = !!after.lastCompletedAt && after.lastCompletedAt > (before.lastCompletedAt ?? '');
      const recurUndone = !!before.lastCompletedAt && (after.lastCompletedAt ?? '') < before.lastCompletedAt;
      const completedNow = (!before.completedAt && !!after.completedAt) || recurredNow;
      const reopened = (!!before.completedAt && !after.completedAt) || recurUndone;
      if (completedNow && !after.isEvent) {
        await this.activity(q, projectId, user, 'completed', existing.id, `hat „${after.title}“ erledigt`);
        await recordCompletion(q, user, existing.id, { ...before, title: after.title }, e.notices);
      }
      if (reopened) {
        await revokeCompletion(q, existing.id);
        // Versehentlich abgehakt (rückgängig gemacht oder gleich wieder geöffnet): aus der Erledigt-Liste nehmen
        await q.query(
          `DELETE FROM activity WHERE id = (SELECT id FROM activity WHERE object_id = $1 AND kind = 'completed' ORDER BY id DESC LIMIT 1)
             AND ($2 OR created_at > now() - interval '10 minutes')`,
          [existing.id, recurUndone],
        );
      }
      if (after.assigneeId && after.assigneeId !== before.assigneeId && after.assigneeId !== user.id && !after.completedAt) {
        const rotated = completedNow && after.rotation.length > 1;
        e.notices.push({
          userId: after.assigneeId,
          title: rotated ? 'Du bist dran' : 'Neue Aufgabe für dich',
          body: rotated ? after.title : `${user.name}: ${after.title}`,
          taskId: existing.id,
        });
      }
    }
  }

  /** Zuständige müssen Projektmitglieder sein, Hauptaufgaben im selben Projekt liegen. */
  private async checkTaskRefs(q: Queryable, t: TaskData, projectId: string, changed?: string[]): Promise<void> {
    const touches = (k: string) => !changed || changed.includes(k);
    if (t.parentId && (touches('parentId') || touches('projectId'))) {
      const parent = await q.one<{ project_id: string }>(`SELECT project_id FROM objects WHERE id = $1 AND type = 'task' AND NOT deleted`, [t.parentId]);
      if (!parent || parent.project_id !== projectId) throw new Rejection('Die Hauptaufgabe liegt in einem anderen Projekt');
    }
    if (touches('assigneeId') || touches('rotation') || touches('projectId')) {
      const people = [...new Set([t.assigneeId, ...t.rotation].filter((x): x is string => !!x))];
      if (people.length) {
        const rows = await q.query('SELECT user_id FROM project_members WHERE project_id = $1 AND user_id = ANY($2::uuid[])', [projectId, people]);
        if (rows.length < people.length) throw new Rejection('Zuständige Person ist kein Mitglied des Projekts');
      }
    }
  }

  /** Darf der Nutzer dieses Objekt ändern oder löschen? */
  private async checkModify(q: Queryable, roles: Map<string, Role | null>, user: UserRow, row: ObjectRow): Promise<void> {
    if (PRIVATE_TYPES.has(row.type)) {
      if (row.owner_id !== user.id) throw new Rejection('Nicht dein Objekt');
      return;
    }
    if (row.type === 'project') {
      if ((await this.role(q, roles, user.id, row.id)) !== 'owner') throw new Rejection('Nur Besitzer können Projekte ändern');
      return;
    }
    if (row.type === 'comment') {
      if (row.data.authorId !== user.id) throw new Rejection('Nur eigene Kommentare können geändert werden');
      return;
    }
    await this.requireWrite(q, roles, user.id, row.project_id!);
  }

  private async cascadeDelete(q: Queryable, row: ObjectRow, e: Effects): Promise<void> {
    if (row.type === 'project') {
      const rows = await q.query<{ id: string; type: ObjectType }>(
        `UPDATE objects SET deleted = true, seq = nextval('sync_seq'), updated_at = now()
         WHERE project_id = $1 AND id <> $1 AND NOT deleted RETURNING id, type`,
        [row.id],
      );
      for (const r of rows) {
        if (r.type === 'reminder') e.reminderIds.add(r.id);
        if (r.type === 'task') e.taskIds.add(r.id);
      }
    } else if (row.type === 'task') {
      const rows = await q.query<{ id: string; type: ObjectType; owner_id: string | null }>(
        `WITH RECURSIVE sub(id) AS (
           SELECT $1::uuid
           UNION SELECT o.id FROM objects o JOIN sub ON o.type = 'task' AND o.data->>'parentId' = sub.id::text
         )
         UPDATE objects SET deleted = true, seq = nextval('sync_seq'), updated_at = now()
         WHERE NOT deleted AND id <> $1 AND (id IN (SELECT id FROM sub) OR (type IN ('reminder', 'comment') AND (data->>'taskId')::uuid IN (SELECT id FROM sub)))
         RETURNING id, type, owner_id`,
        [row.id],
      );
      for (const r of rows) {
        if (r.type === 'reminder') e.reminderIds.add(r.id);
        if (r.type === 'task') e.taskIds.add(r.id);
        if (r.owner_id) e.users.add(r.owner_id);
      }
    }
  }

  private track(e: Effects, row: ObjectRow, changed?: string[]): void {
    if (row.owner_id) e.users.add(row.owner_id);
    else if (row.project_id) e.projects.add(row.project_id);
    if (row.type === 'task' && (!changed || changed.some((k) => ['dueDate', 'dueTime', 'completedAt', 'projectId', 'recurrence'].includes(k)))) {
      e.taskIds.add(row.id);
    }
    if (row.type === 'reminder') e.reminderIds.add(row.id);
  }

  private commentNotices(task: ObjectRow, author: UserRow, body: string, e: Effects): void {
    const t = task.data as unknown as TaskData;
    const targets = new Set([t.assigneeId, t.createdBy].filter((x): x is string => !!x && x !== author.id));
    for (const userId of targets) {
      e.notices.push({ userId, title: `${author.name} hat kommentiert`, body: `${t.title}: ${body.slice(0, 120)}`, taskId: task.id });
    }
  }

  private async activity(q: Queryable, projectId: string | null, user: UserRow, kind: string, objectId: string, summary: string): Promise<void> {
    await q.query('INSERT INTO activity(project_id, user_id, kind, object_id, summary) VALUES ($1, $2, $3, $4, $5)', [
      projectId,
      user.id,
      kind,
      objectId,
      `${user.name} ${summary}`,
    ]);
  }
}

export function isRejection(err: unknown): err is Error {
  return err instanceof Rejection;
}

function newEffects(): Effects {
  return { projects: new Set(), users: new Set(), taskIds: new Set(), reminderIds: new Set(), notices: [] };
}

function toSyncObject(r: ObjectRow): SyncObject {
  return { id: r.id, type: r.type, projectId: r.project_id, ownerId: r.owner_id, data: r.data, deleted: r.deleted, seq: r.seq };
}
