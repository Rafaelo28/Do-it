import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb } from './db';
import { migrate } from './migrations';
import { startWorker } from './worker';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
await migrate(db);
const { push } = await buildApp({ config, db });
const log = (msg: string, err?: unknown) => (err ? console.error(new Date().toISOString(), msg, err) : console.log(new Date().toISOString(), msg));
log(`Erinnerungs-Dienst läuft (alle ${config.WORKER_INTERVAL_MS / 1000} s)`);
const stop = startWorker(db, push, config.WORKER_INTERVAL_MS, log);

const shutdown = async () => {
  stop();
  await db.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
