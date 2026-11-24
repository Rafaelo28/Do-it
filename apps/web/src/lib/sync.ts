import {
  HybridClock,
  OBJECT_DEFAULTS,
  uuidv7,
  type MemberInfo,
  type Me,
  type ObjectType,
  type PullResponse,
  type PushResponse,
  type SyncObject,
} from '@do-it/shared';
import { api, ApiError } from './api';
import { db, type OutboxEntry } from './db';
import { createStore, toast } from './store';

export interface SyncState {
  status: 'idle' | 'syncing' | 'offline' | 'error';
  pending: number;
  lastSync: number | null;
  error?: string;
  me: Me | null;
  members: MemberInfo[];
  projectIds: string[];
  /** erste vollständige Synchronisierung abgeschlossen (oder lokale Daten vorhanden) */
  ready: boolean;
  /** neuestes Briefing laut Server */
  briefingAt: string | null;
}

export const syncState = createStore<SyncState>({
  status: 'idle',
  pending: 0,
  lastSync: null,
  me: null,
  members: [],
  projectIds: [],
  ready: false,
  briefingAt: null,
});

const OBJECT_TABLES = () => [db.projects, db.sections, db.tasks, db.labels, db.reminders, db.comments, db.notes];

class SyncEngine {
  private clock: HybridClock | null = null;
  private node = '';
  private running = false;
  private again = false;
  private ws: WebSocket | null = null;
  private wsRetry = 0;
  private started = false;
  private timers: number[] = [];
  private debounce: number | null = null;
  private cleanups: (() => void)[] = [];

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    let node = await db.getMeta<string>('node');
    if (!node) {
      node = uuidv7().replace(/-/g, '').slice(-12);
      await db.setMeta('node', node);
    }
    this.node = node;
    this.clock = new HybridClock(node);
    const last = await db.getMeta<string>('lastHlc');
    if (last) this.clock.receive(last);

    const [me, members, projectIds, cursor] = await Promise.all([
      db.getMeta<Me>('me'),
      db.getMeta<MemberInfo[]>('members'),
      db.getMeta<string[]>('projectIds'),
      db.getMeta<number>('cursor'),
    ]);
    syncState.set((s) => ({ ...s, me: me ?? s.me, members: members ?? [], projectIds: projectIds ?? [], ready: !!cursor }));
    await this.updatePending();

    const on = <K extends keyof WindowEventMap>(ev: K, fn: () => void) => {
      window.addEventListener(ev, fn);
      this.cleanups.push(() => window.removeEventListener(ev, fn));
    };
    on('online', () => {
      void this.sync();
      this.connectWs();
    });
    on('offline', () => syncState.set((s) => ({ ...s, status: 'offline' })));
    const vis = () => {
      if (document.visibilityState === 'visible') {
        void this.sync();
        this.connectWs();
      }
    };
    document.addEventListener('visibilitychange', vis);
    this.cleanups.push(() => document.removeEventListener('visibilitychange', vis));
    const swMsg = (e: MessageEvent) => {
      if ((e.data as { type?: string })?.type === 'sync') void this.sync();
    };
    navigator.serviceWorker?.addEventListener('message', swMsg);
    this.cleanups.push(() => navigator.serviceWorker?.removeEventListener('message', swMsg));
    this.timers.push(window.setInterval(() => void this.sync(), 60_000));

    this.connectWs();
    await this.sync();
  }

  stop(): void {
    this.started = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const c of this.cleanups) c();
    this.cleanups = [];
    this.ws?.close();
    this.ws = null;
  }

  /** Lokale Änderung: sofort in IndexedDB, dann im Hintergrund zum Server. */
  /**
   * ifExists: nur ändern, wenn es das Objekt hier noch gibt – sonst entstünde aus einer verspäteten
   * Änderung (z. B. Feld speichert nach dem Löschen) ein unvollständiger "Geister"-Eintrag.
   */
  async mutate(type: ObjectType, id: string, op: 'put' | 'delete', data?: Record<string, unknown>, opts?: { ifExists?: boolean }): Promise<void> {
    if (!this.clock) throw new Error('Sync nicht gestartet');
    const hlc = this.clock.tick();
    const tables = [...OBJECT_TABLES(), db.outbox, db.meta];
    let skipped = false;
    await db.transaction('rw', tables, async () => {
      const table = db.tableFor(type);
      if (op === 'put') {
        const existing = await table.get(id);
        if (!existing && opts?.ifExists) {
          skipped = true;
          return;
        }
        const row = existing ? { ...existing, ...data } : { ...OBJECT_DEFAULTS[type], ...data, id };
        await table.put(row as never);
      } else {
        await table.delete(id);
        await localCascade(type, id);
      }
      await db.outbox.add({ mid: uuidv7(), type, id, op, data, hlc });
      await db.setMeta('lastHlc', hlc);
    });
    if (skipped) return;
    await this.updatePending();
    this.schedule();
  }

  /** Viele Änderungen in einer Transaktion (z. B. Import) – deutlich schneller als einzeln. */
  async mutateMany(items: { type: ObjectType; id: string; data: Record<string, unknown> }[]): Promise<void> {
    if (!this.clock || !items.length) return;
    const clock = this.clock;
    await db.transaction('rw', [...OBJECT_TABLES(), db.outbox, db.meta], async () => {
      let hlc = '';
      for (const it of items) {
        hlc = clock.tick();
        const table = db.tableFor(it.type);
        const existing = await table.get(it.id);
        await table.put((existing ? { ...existing, ...it.data } : { ...OBJECT_DEFAULTS[it.type], ...it.data, id: it.id }) as never);
        await db.outbox.add({ mid: uuidv7(), type: it.type, id: it.id, op: 'put', data: it.data, hlc });
      }
      await db.setMeta('lastHlc', hlc);
    });
    await this.updatePending();
    this.schedule();
  }

  schedule(delay = 250): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => void this.sync(), delay);
  }

  async sync(): Promise<void> {
    if (!this.started) return;
    if (this.running) {
      this.again = true;
      return;
    }
    if (!navigator.onLine) {
      syncState.set((s) => ({ ...s, status: 'offline' }));
      return;
    }
    this.running = true;
    syncState.set((s) => ({ ...s, status: 'syncing' }));
    try {
      do {
        this.again = false;
        await this.pushAll();
        await this.pullAll();
      } while (this.again);
      syncState.set((s) => ({ ...s, status: 'idle', lastSync: Date.now(), error: undefined, ready: true }));
    } catch (err) {
      const offline = err instanceof ApiError && err.status === 0;
      syncState.set((s) => ({ ...s, status: offline ? 'offline' : 'error', error: (err as Error).message }));
    } finally {
      this.running = false;
      await this.updatePending();
    }
  }

  /** Alles lokal verwerfen und neu laden. */
  async resync(): Promise<void> {
    await db.setMeta('cursor', 0);
    await this.sync();
  }

  private async updatePending(): Promise<void> {
    const pending = await db.outbox.count();
    syncState.set((s) => (s.pending === pending ? s : { ...s, pending }));
  }

  private async pushAll(): Promise<void> {
    for (;;) {
      const batch = await db.outbox.orderBy('seq').limit(200).toArray();
      if (!batch.length) return;
      const res = await api<PushResponse>('POST', '/api/sync/push', {
        clientId: this.node,
        mutations: batch.map((m) => ({ mid: m.mid, type: m.type, id: m.id, op: m.op, ...(m.data ? { data: m.data } : {}), hlc: m.hlc })),
      });
      const done = new Set([...res.applied, ...res.rejected.map((r) => r.mid)]);
      await db.outbox.bulkDelete(batch.filter((b) => done.has(b.mid)).map((b) => b.seq!));
      if (res.rejected.length) {
        toast(`Änderung abgelehnt: ${res.rejected[0]!.reason}`, { kind: 'error' });
        await db.setMeta('cursor', 0);
      }
      if (done.size < batch.length) return;
    }
  }

  private async pullAll(): Promise<void> {
    let cursor = (await db.getMeta<number>('cursor')) ?? 0;
    const full = cursor === 0;
    let first = true;
    let resp: PullResponse;
    do {
      resp = await api<PullResponse>('GET', `/api/sync/pull?cursor=${cursor}`);
      await this.apply(resp.objects, full && first);
      first = false;
      cursor = resp.cursor;
      await db.setMeta('cursor', cursor);
    } while (resp.hasMore);

    const known = (await db.getMeta<string[]>('projectIds')) ?? [];
    const added = resp.projectIds.filter((id) => !known.includes(id));
    const removed = known.filter((id) => !resp.projectIds.includes(id));
    if (!full) {
      for (const p of added) {
        const snap = await api<PullResponse>('GET', `/api/sync/pull?project=${p}`);
        await this.apply(snap.objects, false);
      }
    }
    if (removed.length) {
      await db.transaction('rw', OBJECT_TABLES(), async () => {
        await db.projects.bulkDelete(removed);
        await db.sections.where('projectId').anyOf(removed).delete();
        const taskIds = await db.tasks.where('projectId').anyOf(removed).primaryKeys();
        await db.tasks.bulkDelete(taskIds);
        await db.comments.where('taskId').anyOf(taskIds).delete();
        await db.reminders.where('taskId').anyOf(taskIds).delete();
        // aus einem geteilten Projekt entfernt: auch dessen Notizen nicht mehr auf dem Gerät behalten
        await db.notes.where('projectId').anyOf(removed).delete();
      });
    }
    await db.setMeta('projectIds', resp.projectIds);
    await db.setMeta('members', resp.members);
    await db.setMeta('me', resp.me);
    syncState.set((s) => ({
      ...s,
      me: JSON.stringify(s.me) === JSON.stringify(resp.me) ? s.me : resp.me,
      members: JSON.stringify(s.members) === JSON.stringify(resp.members) ? s.members : resp.members,
      projectIds: s.projectIds.join() === resp.projectIds.join() ? s.projectIds : resp.projectIds,
      briefingAt: resp.briefingAt ?? null,
    }));
  }

  private async apply(objects: SyncObject[], clearFirst: boolean): Promise<void> {
    await db.transaction('rw', [...OBJECT_TABLES(), db.outbox], async () => {
      if (clearFirst) await Promise.all(OBJECT_TABLES().map((t) => t.clear()));
      if (!objects.length) return;
      const pending = new Map<string, OutboxEntry[]>();
      for (const p of await db.outbox.toArray()) {
        const list = pending.get(p.id) ?? [];
        list.push(p);
        pending.set(p.id, list);
      }
      for (const o of objects) {
        const table = db.tableFor(o.type);
        // unbekannter Typ (Server ist neuer als diese App-Version): überspringen statt abzubrechen
        if (!table) continue;
        if (o.deleted) {
          await table.delete(o.id);
          continue;
        }
        const pend = pending.get(o.id);
        if (pend?.some((p) => p.op === 'delete')) continue;
        let row: Record<string, unknown> = { ...o.data, id: o.id };
        for (const p of pend ?? []) row = { ...row, ...p.data };
        await table.put(row as never);
      }
    });
  }

  private connectWs(): void {
    if (this.ws || !this.started || !navigator.onLine) return;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/sync/ws`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      return;
    }
    this.ws = ws;
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(String(e.data)) as { type: string };
        if (msg.type === 'poke') void this.sync();
        if (msg.type === 'hello') this.wsRetry = 0;
      } catch {
        /* ignorieren */
      }
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (!this.started) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.wsRetry++);
      window.setTimeout(() => this.connectWs(), delay);
    };
    ws.onerror = () => ws.close();
  }
}

async function localCascade(type: ObjectType, id: string): Promise<void> {
  if (type === 'project') {
    await db.sections.where('projectId').equals(id).delete();
    const taskIds = await db.tasks.where('projectId').equals(id).primaryKeys();
    await db.tasks.bulkDelete(taskIds);
    await db.reminders.where('taskId').anyOf(taskIds).delete();
    await db.comments.where('taskId').anyOf(taskIds).delete();
    await db.notes.where('projectId').equals(id).delete();
  } else if (type === 'task') {
    const children = await db.tasks.where('parentId').equals(id).primaryKeys();
    for (const c of children) {
      await db.tasks.delete(c);
      await localCascade('task', c);
    }
    await db.reminders.where('taskId').equals(id).delete();
    await db.comments.where('taskId').equals(id).delete();
  }
}

export const sync = new SyncEngine();

/** Abmelden: lokale Daten vollständig löschen. */
export async function wipeLocalData(): Promise<void> {
  sync.stop();
  db.close();
  await db.delete();
}
