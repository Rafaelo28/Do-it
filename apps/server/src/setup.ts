import { randomInt, timingSafeEqual } from 'node:crypto';
import type { Config } from './config';
import type { Db } from './db';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(): string {
  const s = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function normalize(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export async function setupRequired(db: Db): Promise<boolean> {
  const row = await db.one<{ n: number }>('SELECT count(*)::int AS n FROM users');
  return (row?.n ?? 0) === 0;
}

/**
 * Einrichtungscode für das erste Konto. Wer die Seite zuerst findet, kann sich so nicht
 * einfach selbst zum Admin machen: der Code steht nur im Server-Log.
 */
export async function setupCode(db: Db, config: Config): Promise<string> {
  if (config.SETUP_CODE) return config.SETUP_CODE;
  await db.query(`INSERT INTO server_kv(key, value) VALUES ('setup_code', $1) ON CONFLICT (key) DO NOTHING`, [randomCode()]);
  const row = await db.one<{ value: string }>(`SELECT value FROM server_kv WHERE key = 'setup_code'`);
  return row!.value;
}

export async function checkSetupCode(db: Db, config: Config, given: string): Promise<boolean> {
  const a = Buffer.from(normalize(await setupCode(db, config)));
  const b = Buffer.from(normalize(given));
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function clearSetupCode(db: Db): Promise<void> {
  await db.query(`DELETE FROM server_kv WHERE key = 'setup_code'`);
}
