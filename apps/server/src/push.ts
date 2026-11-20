import { timingSafeEqual } from 'node:crypto';
import { uuidv7 } from '@do-it/shared';
import * as webpush from 'web-push';
import { hmac } from './auth';
import type { Db } from './db';
import type { ServerKeys } from './keys';

export interface PushAction {
  action: 'done' | 'snooze' | 'tomorrow';
  title: string;
}

export interface PushPayload {
  title: string;
  body?: string;
  tag?: string;
  url?: string;
  taskId?: string;
  actions?: PushAction[];
  /** signierte Kurzzeit-Tokens je Aktion */
  tokens?: Record<string, string>;
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Versand-Schicht; in Tests wird sie ersetzt. Liefert den HTTP-Status des Push-Dienstes. */
export interface PushTransport {
  send(sub: PushSubscriptionInput, payload: string, topic?: string): Promise<number>;
}

export function webPushTransport(keys: ServerKeys): PushTransport {
  return {
    async send(sub, payload, topic) {
      try {
        const res = await webpush.sendNotification(sub, payload, {
          TTL: 6 * 3600,
          urgency: 'high',
          ...(topic ? { topic } : {}),
          vapidDetails: { subject: keys.vapidSubject, publicKey: keys.vapidPublic, privateKey: keys.vapidPrivate },
        });
        return res.statusCode;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status) return status;
        throw err;
      }
    },
  };
}

interface SubRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export class PushService {
  constructor(
    private readonly db: Db,
    private readonly keys: ServerKeys,
    private readonly transport: PushTransport,
  ) {}

  async subscribe(userId: string, sub: PushSubscriptionInput, userAgent?: string): Promise<void> {
    await this.db.query(
      `INSERT INTO push_subscriptions(id, user_id, endpoint, p256dh, auth, user_agent) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, failures = 0`,
      [uuidv7(), userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent?.slice(0, 300) ?? null],
    );
  }

  async unsubscribe(userId: string, endpoint: string): Promise<void> {
    await this.db.query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [userId, endpoint]);
  }

  async deviceCount(userId: string): Promise<number> {
    const row = await this.db.one<{ n: number }>('SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1', [userId]);
    return row?.n ?? 0;
  }

  /** Schickt an alle Geräte des Nutzers. Abgelaufene Abos werden gelöscht. Liefert Anzahl erfolgreicher Zustellungen. */
  async sendToUser(userId: string, payload: PushPayload): Promise<number> {
    const subs = await this.db.query<SubRow>('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1', [userId]);
    const body = JSON.stringify(payload);
    let ok = 0;
    await Promise.all(
      subs.map(async (s) => {
        try {
          const status = await this.transport.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, payload.tag?.slice(0, 32));
          if (status >= 200 && status < 300) {
            ok++;
            await this.db.query('UPDATE push_subscriptions SET last_success_at = now(), failures = 0 WHERE id = $1', [s.id]);
          } else if (status === 404 || status === 410) {
            await this.db.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]);
          } else {
            await this.db.query('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = $1', [s.id]);
          }
        } catch {
          await this.db.query('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = $1', [s.id]);
        }
      }),
    );
    await this.db.query('DELETE FROM push_subscriptions WHERE user_id = $1 AND failures >= 20', [userId]);
    return ok;
  }

  signAction(userId: string, taskId: string, action: string, ttlMs = 24 * 3600_000): string {
    const exp = Date.now() + ttlMs;
    const body = `${userId}.${taskId}.${action}.${exp}`;
    return `${body}.${hmac(this.keys.authSecret, `push-action:${body}`)}`;
  }

  verifyAction(token: string): { userId: string; taskId: string; action: string } | null {
    const parts = token.split('.');
    if (parts.length !== 5) return null;
    const [userId, taskId, action, exp, sig] = parts as [string, string, string, string, string];
    const expected = hmac(this.keys.authSecret, `push-action:${userId}.${taskId}.${action}.${exp}`);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    if (Number(exp) < Date.now()) return null;
    return { userId, taskId, action };
  }

  /** Aktionen und Tokens für eine Aufgaben-Benachrichtigung. */
  taskActions(userId: string, taskId: string): Pick<PushPayload, 'actions' | 'tokens'> {
    const actions: PushAction[] = [
      { action: 'done', title: 'Erledigt' },
      { action: 'snooze', title: 'In 1 Std.' },
      { action: 'tomorrow', title: 'Morgen' },
    ];
    const tokens: Record<string, string> = {};
    for (const a of actions) tokens[a.action] = this.signAction(userId, taskId, a.action);
    return { actions, tokens };
  }
}
