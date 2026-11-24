import { createHash, timingSafeEqual } from 'node:crypto';
import { uuidv7 } from '@do-it/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { clientIpOf, hmac, LEGACY_SESSION_COOKIE, newToken, RateLimiter, sessionCookieName, sha256, userForSession, type UserRow } from './auth';
import type { Config } from './config';
import type { Db } from './db';
import { HttpError } from './errors';
import type { ServerKeys } from './keys';

/**
 * OAuth 2.1 für den MCP-Connector (so verbindet sich Claude wie bei Todoist):
 * - Discovery: /.well-known/oauth-protected-resource und /.well-known/oauth-authorization-server
 * - Dynamische Client-Registrierung: POST /oauth/register
 * - Freigabe mit PKCE (S256): GET/POST /oauth/authorize
 * - Tokens: POST /oauth/token (authorization_code, refresh_token mit Rotation)
 * Dazu persönliche Zugangsschlüssel für Claude Code & Co.
 */

export const SCOPES = ['tasks:read', 'tasks:write'] as const;
export type Scope = (typeof SCOPES)[number];

const ACCESS_TTL_S = 24 * 3600;
const REFRESH_TTL_S = 180 * 24 * 3600;
const CODE_TTL_S = 600;

export interface BearerAuth {
  user: UserRow;
  scopes: Set<string>;
  tokenId: string;
}

function origin(config: Config): string {
  return new URL(config.APP_URL).origin;
}

export function resourceUrl(config: Config): string {
  return `${origin(config)}/mcp`;
}

function normalizeScope(raw: string | undefined): string {
  const asked = (raw ?? '').split(/\s+/).filter((s) => (SCOPES as readonly string[]).includes(s));
  return (asked.length ? asked : [...SCOPES]).join(' ');
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function validRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

/** Bearer-Token prüfen (für /mcp). */
export async function authenticateBearer(db: Db, header: string | undefined): Promise<BearerAuth | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  if (!m) return null;
  const row = await db.one<UserRow & { token_id: string; scope: string; last_used_at: Date | null }>(
    `SELECT u.*, t.id AS token_id, t.scope, t.last_used_at FROM api_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1 AND t.kind IN ('personal', 'access') AND (t.expires_at IS NULL OR t.expires_at > now())`,
    [sha256(m[1]!)],
  );
  if (!row) return null;
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 5 * 60_000) {
    await db.query('UPDATE api_tokens SET last_used_at = now() WHERE id = $1', [row.token_id]);
  }
  const { token_id, scope, last_used_at: _l, ...user } = row;
  return { user, scopes: new Set(scope.split(' ')), tokenId: token_id };
}

async function issueTokens(db: Db, userId: string, clientId: string, clientName: string, scope: string, grantId: string) {
  const access = `doit_at_${newToken(32)}`;
  const refresh = `doit_rt_${newToken(32)}`;
  await db.query(
    `INSERT INTO api_tokens(id, user_id, kind, name, token_hash, client_id, grant_id, scope, expires_at) VALUES
     ($1, $3, 'access', $4, $5, $6, $7, $8, now() + ($9 || ' seconds')::interval),
     ($2, $3, 'refresh', $4, $10, $6, $7, $8, now() + ($11 || ' seconds')::interval)`,
    [uuidv7(), uuidv7(), userId, clientName, sha256(access), clientId, grantId, scope, String(ACCESS_TTL_S), sha256(refresh), String(REFRESH_TTL_S)],
  );
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} – Do-it</title><link rel="icon" href="/icons/icon.svg">
<style>
:root{--bg:#f7f6f3;--card:#fff;--text:#1d1f21;--muted:#676b72;--border:#e4e1da;--accent:#0f8b6c;--accent-text:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#14181c;--card:#1c2126;--text:#e8eaed;--muted:#a0a6ad;--border:#2b3138;--accent:#34c99c;--accent-text:#08231b}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px;box-sizing:border-box}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:28px;max-width:440px;width:100%;box-sizing:border-box}
h1{font-size:1.35rem;margin:12px 0 8px}p,li{color:var(--muted)}ul{padding-left:20px}
.row{display:flex;gap:8px;margin-top:20px}button{flex:1;min-height:42px;border-radius:9px;border:1px solid var(--border);background:var(--card);color:var(--text);font:inherit;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text);font-weight:600}img{width:48px;height:48px}
</style></head><body><div class="card">${body}</div></body></html>`;
}

export function registerOAuth(app: FastifyInstance, deps: { db: Db; config: Config; keys: ServerKeys }) {
  const { db, config, keys } = deps;
  const base = origin(config);
  const COOKIE = sessionCookieName(config.secureCookies);
  const sessionToken = (req: FastifyRequest) => req.cookies[COOKIE] ?? req.cookies[LEGACY_SESSION_COOKIE];
  const registerLimiter = new RateLimiter(20, 60 * 60_000);
  const tokenLimiter = new RateLimiter(120, 15 * 60_000);
  const ip = clientIpOf;

  // Formulare (application/x-www-form-urlencoded), wie OAuth sie vorschreibt
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });

  // CORS nur für die öffentlichen OAuth-/MCP-Endpunkte (Bearer-Token, keine Cookies)
  const corsPaths = /^\/(\.well-known\/|oauth\/token|oauth\/register|mcp)/;
  app.addHook('onRequest', async (req, reply) => {
    if (!corsPaths.test(req.url)) return;
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    reply.header('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id');
    if (req.method === 'OPTIONS') return reply.code(204).send();
  });

  const protectedResource = () => ({
    resource: resourceUrl(config),
    authorization_servers: [base],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Do-it',
  });
  app.get('/.well-known/oauth-protected-resource', async () => protectedResource());
  app.get('/.well-known/oauth-protected-resource/mcp', async () => protectedResource());

  const asMetadata = () => ({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: [...SCOPES],
  });
  app.get('/.well-known/oauth-authorization-server', async () => asMetadata());
  app.get('/.well-known/oauth-authorization-server/mcp', async () => asMetadata());
  app.get('/.well-known/openid-configuration', async () => asMetadata());

  // ---------- Dynamische Client-Registrierung (RFC 7591) ----------
  app.post('/oauth/register', async (req, reply) => {
    if (!registerLimiter.check(ip(req))) return reply.code(429).send({ error: 'too_many_requests' });
    const parsed = z
      .object({
        redirect_uris: z.array(z.string().max(500)).min(1).max(10),
        client_name: z.string().max(100).optional(),
        token_endpoint_auth_method: z.enum(['none', 'client_secret_post', 'client_secret_basic']).default('none'),
        grant_types: z.array(z.string()).optional(),
        response_types: z.array(z.string()).optional(),
        scope: z.string().max(200).optional(),
      })
      .passthrough()
      .safeParse(req.body);
    if (!parsed.success || !parsed.data.redirect_uris.every(validRedirect)) {
      return reply.code(400).send({ error: 'invalid_redirect_uri', error_description: 'Nur https- oder localhost-Adressen sind erlaubt' });
    }
    const b = parsed.data;
    const id = `doit_c_${newToken(16)}`;
    const secret = b.token_endpoint_auth_method === 'none' ? null : newToken(32);
    const name = b.client_name?.trim() || 'Unbekannte App';
    await db.query('INSERT INTO oauth_clients(id, secret_hash, name, redirect_uris) VALUES ($1, $2, $3, $4)', [
      id,
      secret ? sha256(secret) : null,
      name,
      JSON.stringify(b.redirect_uris),
    ]);
    return reply.code(201).send({
      client_id: id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_name: name,
      redirect_uris: b.redirect_uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: b.token_endpoint_auth_method,
      scope: SCOPES.join(' '),
    });
  });

  // ---------- Freigabe ----------
  const authorizeQuery = z.object({
    response_type: z.literal('code'),
    client_id: z.string().max(100),
    redirect_uri: z.string().max(500),
    code_challenge: z.string().min(43).max(128),
    code_challenge_method: z.literal('S256'),
    state: z.string().max(1000).optional(),
    scope: z.string().max(200).optional(),
    resource: z.string().max(500).optional(),
  });

  async function loadClient(id: string): Promise<{ id: string; name: string; redirect_uris: string[]; secret_hash: string | null } | null> {
    return db.one('SELECT id, name, redirect_uris, secret_hash FROM oauth_clients WHERE id = $1', [id]);
  }

  function errorPage(reply: FastifyReply, msg: string) {
    return reply.code(400).type('text/html; charset=utf-8').send(page('Fehler', `<img src="/icons/icon.svg" alt=""><h1>Das hat nicht geklappt</h1><p>${esc(msg)}</p>`));
  }

  app.get('/oauth/authorize', async (req, reply) => {
    const q = authorizeQuery.safeParse(req.query);
    if (!q.success) return errorPage(reply, 'Die Anfrage ist unvollständig (PKCE mit S256 ist Pflicht).');
    const client = await loadClient(q.data.client_id);
    if (!client || !client.redirect_uris.includes(q.data.redirect_uri)) return errorPage(reply, 'Unbekannte App oder Rücksprung-Adresse.');
    const token = sessionToken(req);
    const user = await userForSession(db, token);
    if (!user) return reply.redirect(`/login?next=${encodeURIComponent(req.url)}`);

    const params = new URLSearchParams(req.query as Record<string, string>).toString();
    const csrf = hmac(keys.authSecret, `oauth-consent:${sha256(token!)}:${params}`);
    const scope = normalizeScope(q.data.scope);
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'");
    return reply.type('text/html; charset=utf-8').send(
      page(
        'Zugriff erlauben',
        `<img src="/icons/icon.svg" alt="">
<h1>${esc(client.name)} möchte auf Do-it zugreifen</h1>
<p>Angemeldet als <b>${esc(user.name)}</b> (${esc(user.email)}). ${esc(client.name)} darf dann:</p>
<ul>${scope.includes('tasks:read') ? '<li>deine Aufgaben, Projekte und Notizen lesen</li>' : ''}${
          scope.includes('tasks:write') ? '<li>Aufgaben und Notizen anlegen und ändern, Aufgaben abhaken und Briefings für dich speichern</li>' : ''
        }</ul>
<p>Du kannst den Zugriff jederzeit in Do-it unter Einstellungen → Claude wieder trennen.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="params" value="${esc(params)}"><input type="hidden" name="csrf" value="${esc(csrf)}">
<div class="row"><button name="decision" value="deny">Ablehnen</button><button class="primary" name="decision" value="allow">Erlauben</button></div>
</form>`,
      ),
    );
  });

  app.post('/oauth/authorize', async (req, reply) => {
    const o = req.headers.origin;
    if (o && !config.origins.includes(o)) throw new HttpError(403, 'Fremde Origin');
    const body = z.object({ params: z.string().max(4000), csrf: z.string().max(200), decision: z.enum(['allow', 'deny']) }).parse(req.body);
    const token = sessionToken(req);
    const user = await userForSession(db, token);
    if (!user) return reply.redirect('/login');
    const expected = hmac(keys.authSecret, `oauth-consent:${sha256(token!)}:${body.params}`);
    if (!safeEqual(expected, body.csrf)) return errorPage(reply, 'Die Freigabe ist abgelaufen. Bitte noch einmal versuchen.');
    const q = authorizeQuery.parse(Object.fromEntries(new URLSearchParams(body.params)));
    const client = await loadClient(q.client_id);
    if (!client || !client.redirect_uris.includes(q.redirect_uri)) return errorPage(reply, 'Unbekannte App oder Rücksprung-Adresse.');

    const target = new URL(q.redirect_uri);
    if (q.state) target.searchParams.set('state', q.state);
    if (body.decision === 'deny') {
      target.searchParams.set('error', 'access_denied');
      return reply.redirect(target.toString());
    }
    const code = newToken(32);
    await db.query(
      `INSERT INTO oauth_codes(code_hash, client_id, user_id, redirect_uri, code_challenge, scope, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' seconds')::interval)`,
      [sha256(code), client.id, user.id, q.redirect_uri, q.code_challenge, normalizeScope(q.scope), String(CODE_TTL_S)],
    );
    target.searchParams.set('code', code);
    target.searchParams.set('iss', base);
    return reply.redirect(target.toString());
  });

  // ---------- Tokens ----------
  function clientCredentials(req: FastifyRequest, body: Record<string, string>): { id?: string; secret?: string } {
    const basic = /^Basic\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    if (basic) {
      const [id, secret] = Buffer.from(basic[1]!, 'base64').toString().split(':');
      return { id: decodeURIComponent(id ?? ''), secret: decodeURIComponent(secret ?? '') };
    }
    return { id: body.client_id, secret: body.client_secret };
  }

  app.post('/oauth/token', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!tokenLimiter.check(ip(req))) return reply.code(429).send({ error: 'slow_down' });
    const body = (req.body ?? {}) as Record<string, string>;
    const creds = clientCredentials(req, body);
    const client = creds.id ? await loadClient(creds.id) : null;
    if (!client) return reply.code(401).send({ error: 'invalid_client' });
    if (client.secret_hash && !(creds.secret && safeEqual(sha256(creds.secret), client.secret_hash))) {
      return reply.code(401).send({ error: 'invalid_client' });
    }

    if (body.grant_type === 'authorization_code') {
      const row = await db.one<{ user_id: string; redirect_uri: string; code_challenge: string; scope: string; client_id: string }>(
        'DELETE FROM oauth_codes WHERE code_hash = $1 AND expires_at > now() RETURNING user_id, redirect_uri, code_challenge, scope, client_id',
        [sha256(body.code ?? '')],
      );
      if (!row || row.client_id !== client.id) return reply.code(400).send({ error: 'invalid_grant', error_description: 'Code ungültig oder abgelaufen' });
      if (body.redirect_uri && body.redirect_uri !== row.redirect_uri) return reply.code(400).send({ error: 'invalid_grant' });
      if (!body.code_verifier || !safeEqual(s256(body.code_verifier), row.code_challenge)) {
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'PKCE-Prüfung fehlgeschlagen' });
      }
      return issueTokens(db, row.user_id, client.id, client.name, row.scope, uuidv7());
    }

    if (body.grant_type === 'refresh_token') {
      const old = await db.one<{ user_id: string; grant_id: string; scope: string; client_id: string }>(
        `DELETE FROM api_tokens WHERE token_hash = $1 AND kind = 'refresh' AND expires_at > now() RETURNING user_id, grant_id, scope, client_id`,
        [sha256(body.refresh_token ?? '')],
      );
      if (!old || old.client_id !== client.id) return reply.code(400).send({ error: 'invalid_grant' });
      // Rotation: alte Zugangstokens dieser Freigabe verfallen
      await db.query(`DELETE FROM api_tokens WHERE grant_id = $1`, [old.grant_id]);
      return issueTokens(db, old.user_id, client.id, client.name, old.scope, old.grant_id);
    }

    return reply.code(400).send({ error: 'unsupported_grant_type' });
  });

  app.post('/oauth/revoke', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    if (body.token) {
      const row = await db.one<{ grant_id: string | null }>(`SELECT grant_id FROM api_tokens WHERE token_hash = $1 AND kind <> 'personal'`, [sha256(body.token)]);
      if (row?.grant_id) await db.query('DELETE FROM api_tokens WHERE grant_id = $1', [row.grant_id]);
    }
    return reply.code(200).send({});
  });

  // ---------- Verbindungen in den Einstellungen ----------
  async function requireUser(req: FastifyRequest): Promise<UserRow> {
    const user = await userForSession(db, sessionToken(req));
    if (!user) throw new HttpError(401, 'Nicht angemeldet');
    return user;
  }

  app.get('/api/connections', async (req) => {
    const user = await requireUser(req);
    const rows = await db.query<{ id: string; kind: string; name: string; grant_id: string | null; created_at: Date; last_used_at: Date | null }>(
      `SELECT DISTINCT ON (COALESCE(grant_id, id)) id, kind, name, grant_id, created_at, last_used_at FROM api_tokens
       WHERE user_id = $1 AND kind IN ('personal', 'access', 'refresh') ORDER BY COALESCE(grant_id, id), kind`,
      [user.id],
    );
    return {
      mcpUrl: resourceUrl(config),
      connections: rows
        .map((r) => ({
          id: r.grant_id ?? r.id,
          kind: r.kind === 'personal' ? 'token' : 'oauth',
          name: r.name,
          createdAt: r.created_at,
          lastUsedAt: r.last_used_at,
        }))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    };
  });

  app.post('/api/tokens', async (req) => {
    const user = await requireUser(req);
    const { name } = z.object({ name: z.string().trim().min(1).max(80).default('Claude Code') }).parse(req.body ?? {});
    const token = `doit_pat_${newToken(32)}`;
    await db.query(`INSERT INTO api_tokens(id, user_id, kind, name, token_hash, scope) VALUES ($1, $2, 'personal', $3, $4, $5)`, [
      uuidv7(),
      user.id,
      name,
      sha256(token),
      SCOPES.join(' '),
    ]);
    return { token, mcpUrl: resourceUrl(config) };
  });

  app.delete('/api/connections/:id', async (req) => {
    const user = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await db.query('DELETE FROM api_tokens WHERE user_id = $1 AND (id = $2 OR grant_id = $2)', [user.id, id]);
    return { ok: true };
  });
}
