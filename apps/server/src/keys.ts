import { randomBytes } from 'node:crypto';
import * as webpush from 'web-push';
import type { Config } from './config';
import type { Db } from './db';

export interface ServerKeys {
  authSecret: string;
  vapidPublic: string;
  vapidPrivate: string;
  vapidSubject: string;
}

async function kv(db: Db, key: string, create: () => string): Promise<string> {
  await db.query('INSERT INTO server_kv(key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, create()]);
  const row = await db.one<{ value: string }>('SELECT value FROM server_kv WHERE key = $1', [key]);
  return row!.value;
}

/**
 * Geheimnisse aus der Umgebung oder – falls nicht gesetzt – einmalig erzeugt und in der DB gespeichert.
 * So braucht die .env nur die Datenbank-Verbindung.
 */
export async function loadKeys(db: Db, config: Config): Promise<ServerKeys> {
  const authSecret = config.AUTH_SECRET ?? (await kv(db, 'auth_secret', () => randomBytes(32).toString('base64url')));
  let vapidPublic = config.VAPID_PUBLIC_KEY;
  let vapidPrivate = config.VAPID_PRIVATE_KEY;
  if (!vapidPublic || !vapidPrivate) {
    const generated = webpush.generateVAPIDKeys();
    const stored = await kv(db, 'vapid', () => JSON.stringify(generated));
    const parsed = JSON.parse(stored) as { publicKey: string; privateKey: string };
    vapidPublic = parsed.publicKey;
    vapidPrivate = parsed.privateKey;
  }
  const host = new URL(config.APP_URL).hostname;
  const vapidSubject = config.VAPID_SUBJECT ?? `mailto:admin@${host.includes('.') ? host : 'example.org'}`;
  return { authSecret, vapidPublic, vapidPrivate, vapidSubject };
}
