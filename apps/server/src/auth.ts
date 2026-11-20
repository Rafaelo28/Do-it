import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { DEFAULT_SETTINGS, generateKeyBetween, uuidv7, type Me, type UserSettings } from '@do-it/shared';
import type { Queryable } from './db';
import { lockObjects } from './db';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('base64url');
}

export function hmac(secret: string, s: string): string {
  return createHmac('sha256', secret).update(s).digest('base64url');
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export const SESSION_COOKIE = 'doit_session';
export const SESSION_DAYS = 180;

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  timezone: string;
  settings: Partial<UserSettings>;
  is_admin: boolean;
  ical_token: string | null;
  last_briefing_date: string | null;
}

export function settingsOf(u: Pick<UserRow, 'settings'>): UserSettings {
  return { ...DEFAULT_SETTINGS, ...u.settings };
}

export function toMe(u: UserRow): Me {
  return { id: u.id, name: u.name, email: u.email, timezone: u.timezone, isAdmin: u.is_admin, settings: settingsOf(u) };
}

export async function createSession(q: Queryable, userId: string, userAgent: string | undefined): Promise<string> {
  const token = newToken();
  await q.query(
    `INSERT INTO sessions(token_hash, user_id, expires_at, user_agent) VALUES ($1, $2, now() + ($3 || ' days')::interval, $4)`,
    [sha256(token), userId, String(SESSION_DAYS), userAgent?.slice(0, 300) ?? null],
  );
  return token;
}

export async function userForSession(q: Queryable, token: string | undefined): Promise<UserRow | null> {
  if (!token) return null;
  const hash = sha256(token);
  const row = await q.one<UserRow & { last_seen_at: Date }>(
    `SELECT u.*, s.last_seen_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hash],
  );
  if (!row) return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() > 6 * 3600_000) {
    await q.query(`UPDATE sessions SET last_seen_at = now(), expires_at = now() + ($2 || ' days')::interval WHERE token_hash = $1`, [
      hash,
      String(SESSION_DAYS),
    ]);
  }
  const { last_seen_at: _ignored, ...user } = row;
  return user;
}

export async function deleteSession(q: Queryable, token: string | undefined): Promise<void> {
  if (token) await q.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Legt einen Nutzer samt privatem Eingangs-Projekt an. */
export async function createUser(
  q: Queryable,
  input: { name: string; email: string; password: string; timezone: string; isAdmin: boolean },
): Promise<UserRow> {
  const id = uuidv7();
  const hash = await hashPassword(input.password);
  const user = await q.one<UserRow>(
    `INSERT INTO users(id, email, name, password_hash, timezone, is_admin) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [id, normalizeEmail(input.email), input.name.trim(), hash, input.timezone, input.isAdmin],
  );
  const inboxId = uuidv7();
  await lockObjects(q);
  const data = {
    name: 'Eingang',
    color: null,
    isInbox: true,
    parentId: null,
    sortKey: generateKeyBetween(null, null),
    archived: false,
    aliases: [],
  };
  await q.query(`INSERT INTO objects(id, type, project_id, owner_id, data, clock, created_by) VALUES ($1, 'project', $1, NULL, $2, '{}', $3)`, [
    inboxId,
    data,
    id,
  ]);
  await q.query(`INSERT INTO project_members(project_id, user_id, role) VALUES ($1, $2, 'owner')`, [inboxId, id]);
  return user!;
}

/** Einfaches Rate-Limit im Speicher (eine Instanz reicht für eine kleine Gruppe). */
export class RateLimiter {
  private hits = new Map<string, { count: number; reset: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** true = erlaubt */
  check(key: string): boolean {
    const now = Date.now();
    const e = this.hits.get(key);
    if (!e || e.reset < now) {
      this.hits.set(key, { count: 1, reset: now + this.windowMs });
      if (this.hits.size > 10_000) this.prune(now);
      return true;
    }
    e.count++;
    return e.count <= this.max;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private prune(now: number): void {
    for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
  }
}
