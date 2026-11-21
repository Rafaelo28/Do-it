import type { Db } from './db';
import type { PushService } from './push';
import { processBriefings, processDueReminders } from './reminders';

/** Startet die Erinnerungs-Schleife. Gibt eine Stopp-Funktion zurück. */
export function startWorker(db: Db, push: PushService, intervalMs: number, log: (msg: string, err?: unknown) => void): () => void {
  let running = false;
  let stopped = false;
  let lastCleanup = 0;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const r = await processDueReminders(db, push);
      const b = await processBriefings(db, push);
      if (r.sent || r.missed || b) log(`Erinnerungen: ${r.sent} gesendet, ${r.missed} verpasst, ${b} Briefings`);
      await db.query(
        `INSERT INTO server_kv(key, value) VALUES ('worker_heartbeat', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [new Date().toISOString()],
      );
      if (Date.now() - lastCleanup > 3600_000) {
        lastCleanup = Date.now();
        await cleanup(db);
      }
    } catch (err) {
      log('Fehler im Erinnerungs-Dienst', err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** Stündliches Aufräumen: abgelaufene Sitzungen, Codes und Tokens, alte Protokolle. */
export async function cleanup(db: Db): Promise<void> {
  await db.query(`DELETE FROM applied_mutations WHERE applied_at < now() - interval '30 days'`);
  await db.query(`DELETE FROM sessions WHERE expires_at < now()`);
  await db.query(`DELETE FROM oauth_codes WHERE expires_at < now()`);
  await db.query(`DELETE FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at < now()`);
  await db.query(
    `DELETE FROM oauth_clients c WHERE c.created_at < now() - interval '30 days'
       AND NOT EXISTS (SELECT 1 FROM api_tokens t WHERE t.client_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM oauth_codes o WHERE o.client_id = c.id)`,
  );
  await db.query(`DELETE FROM invites WHERE expires_at < now() - interval '30 days'`);
  await db.query(`DELETE FROM activity WHERE created_at < now() - interval '365 days'`);
  await db.query(`DELETE FROM briefings WHERE created_at < now() - interval '180 days'`);
}
