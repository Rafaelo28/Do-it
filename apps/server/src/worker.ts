import type { Db } from './db';
import type { PushService } from './push';
import { processBriefings, processDueReminders } from './reminders';

/** Startet die Erinnerungs-Schleife. Gibt eine Stopp-Funktion zurück. */
export function startWorker(db: Db, push: PushService, intervalMs: number, log: (msg: string, err?: unknown) => void): () => void {
  let running = false;
  let stopped = false;
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
      await db.query(`DELETE FROM applied_mutations WHERE applied_at < now() - interval '30 days'`);
      await db.query(`DELETE FROM sessions WHERE expires_at < now()`);
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
