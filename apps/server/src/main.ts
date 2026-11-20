import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb } from './db';
import { migrate } from './migrations';
import { setupCode, setupRequired } from './setup';
import { startWorker } from './worker';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const applied = await migrate(db);
const { app, hub, push } = await buildApp({ config, db, logger: { level: config.LOG_LEVEL } });
if (applied) app.log.info(`${applied} Datenbank-Migration(en) ausgeführt`);
if (await setupRequired(db)) {
  app.log.warn(`Noch kein Konto vorhanden. Einrichtungscode für das erste Konto: ${await setupCode(db, config)}`);
}
hub.startPing();
const stopWorker = config.RUN_WORKER
  ? startWorker(db, push, config.WORKER_INTERVAL_MS, (msg, err) => (err ? app.log.error({ err }, msg) : app.log.info(msg)))
  : () => {};

await app.listen({ port: config.PORT, host: config.HOST });

const shutdown = async () => {
  stopWorker();
  hub.stop();
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
