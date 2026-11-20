import { randomBytes } from 'node:crypto';
import { hashPassword, normalizeEmail } from './auth';
import { loadConfig } from './config';
import { createDb } from './db';
import { migrate } from './migrations';

/**
 * Admin-Werkzeug im Container:
 *   docker compose exec app node dist/cli.js users
 *   docker compose exec app node dist/cli.js reset-password anna@example.org
 *   docker compose exec app node dist/cli.js make-admin anna@example.org
 */
const [cmd, arg] = process.argv.slice(2);
const db = createDb(loadConfig().DATABASE_URL);
await migrate(db);

try {
  if (cmd === 'users') {
    const rows = await db.query<{ email: string; name: string; is_admin: boolean; created_at: Date }>(
      'SELECT email, name, is_admin, created_at FROM users ORDER BY created_at',
    );
    for (const r of rows) console.log(`${r.is_admin ? '★' : ' '} ${r.email.padEnd(36)} ${r.name}`);
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
  } else {
    console.log('Befehle: users | reset-password <email> | make-admin <email>');
    process.exitCode = 1;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.close();
}
