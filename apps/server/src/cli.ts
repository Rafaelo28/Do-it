import { randomBytes } from 'node:crypto';
import { hashPassword, normalizeEmail } from './auth';
import { loadConfig } from './config';
import { createDb } from './db';
import { migrate } from './migrations';
import { setupCode, setupRequired } from './setup';

/**
 * Admin-Werkzeug im Container:
 *   docker compose exec app node dist/cli.js users
 *   docker compose exec app node dist/cli.js reset-password anna@example.org
 *   docker compose exec app node dist/cli.js make-admin anna@example.org
 *   docker compose exec app node dist/cli.js disable-2fa anna@example.org
 *   docker compose exec app node dist/cli.js setup-code
 */
const [cmd, arg] = process.argv.slice(2);
const config = loadConfig();
const db = createDb(config.DATABASE_URL);
await migrate(db);

try {
  if (cmd === 'users') {
    const rows = await db.query<{ email: string; name: string; is_admin: boolean; created_at: Date }>(
      'SELECT email, name, is_admin, created_at FROM users ORDER BY created_at',
    );
    for (const r of rows) console.log(`${r.is_admin ? 'Admin' : '     '}  ${r.email.padEnd(36)} ${r.name}`);
  } else if (cmd === 'reset-password' && arg) {
    const password = randomBytes(9).toString('base64url');
    const res = await db.query('UPDATE users SET password_hash = $2 WHERE email = $1 RETURNING id', [normalizeEmail(arg), await hashPassword(password)]);
    if (!res.length) throw new Error(`Kein Konto mit ${arg}`);
    await db.query('DELETE FROM sessions WHERE user_id = $1', [(res[0] as { id: string }).id]);
    console.log(`Neues Passwort für ${arg}: ${password}\n(Bitte nach dem Anmelden in den Einstellungen ändern.)`);
  } else if (cmd === 'make-admin' && arg) {
    const res = await db.query('UPDATE users SET is_admin = true WHERE email = $1 RETURNING id', [normalizeEmail(arg)]);
    if (!res.length) throw new Error(`Kein Konto mit ${arg}`);
    console.log(`${arg} ist jetzt Admin.`);
  } else if (cmd === 'disable-2fa' && arg) {
    const res = await db.query(
      `UPDATE users SET totp_enabled = false, totp_secret = NULL, totp_last_step = NULL, recovery_codes = '[]' WHERE email = $1 RETURNING id`,
      [normalizeEmail(arg)],
    );
    if (!res.length) throw new Error(`Kein Konto mit ${arg}`);
    console.log(`Zwei-Faktor-Anmeldung für ${arg} ausgeschaltet.`);
  } else if (cmd === 'setup-code') {
    if (await setupRequired(db)) console.log(`Einrichtungscode: ${await setupCode(db, config)}`);
    else console.log('Die Einrichtung ist schon abgeschlossen (es gibt bereits ein Konto).');
  } else {
    console.log('Befehle: users | reset-password <email> | make-admin <email> | disable-2fa <email> | setup-code');
    process.exitCode = 1;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.close();
}
