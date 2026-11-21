import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { zonedParts } from '@do-it/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createDb, type Db } from '../src/db';
import { migrate } from '../src/migrations';

const BASE = process.env.TEST_DATABASE_URL ?? 'postgres://doit:doit@localhost:5432/doit';
const ORIGIN = 'http://localhost:8080';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

type App = Awaited<ReturnType<typeof buildApp>>['app'];
let app: App;
let db: Db;
let dbName: string;
let url = '';
let cookie = '';
const sent: Record<string, unknown>[] = [];

async function req(method: string, path: string, opts: { body?: unknown; form?: Record<string, string>; headers?: Record<string, string> } = {}) {
  const res = await app.inject({
    method: method as 'GET',
    url: path,
    payload: opts.form ? new URLSearchParams(opts.form).toString() : (opts.body as object),
    headers: {
      cookie,
      origin: ORIGIN,
      ...(opts.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...opts.headers,
    },
  });
  const set = res.headers['set-cookie'];
  const first = Array.isArray(set) ? set[0] : set;
  if (first?.startsWith('doit_session=')) cookie = first.split(';')[0]!;
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    /* HTML */
  }
  return { status: res.statusCode, json, body: res.body, headers: res.headers };
}

async function mcpClient(token: string) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

function textOf(r: unknown): string {
  return ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join('\n');
}

beforeAll(async () => {
  dbName = `doit_m_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: BASE });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const u = new URL(BASE);
  u.pathname = `/${dbName}`;
  db = createDb(u.toString());
  await migrate(db);
  const built = await buildApp({
    config: loadConfig({ DATABASE_URL: u.toString(), APP_URL: ORIGIN, SETUP_CODE: 'MCP-TEST-1' } as NodeJS.ProcessEnv),
    db,
    pushTransport: {
      async send(_sub, payload) {
        sent.push(JSON.parse(payload) as Record<string, unknown>);
        return 201;
      },
    },
  });
  app = built.app;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  await req('POST', '/api/auth/setup', {
    body: { name: 'Rafael', email: 'r@example.org', password: 'geheim1234', timezone: 'Europe/Berlin', setupCode: 'MCP-TEST-1' },
  });
  await req('POST', '/api/push/subscription', { body: { endpoint: 'https://push.example/r', keys: { p256dh: 'k', auth: 'a' } } });
});

afterAll(async () => {
  await app?.close();
  await db?.close();
  const admin = new pg.Client({ connectionString: BASE });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

let accessToken = '';
let refreshToken = '';

describe('Claude-Anbindung (OAuth + MCP)', () => {
  it('Discovery und dynamische Registrierung', async () => {
    const unauth = await req('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: { cookie: '' } });
    expect(unauth.status).toBe(401);
    expect(unauth.headers['www-authenticate']).toContain('resource_metadata="http://localhost:8080/.well-known/oauth-protected-resource"');
    const pr = await req('GET', '/.well-known/oauth-protected-resource');
    expect(pr.json).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
    const as = await req('GET', '/.well-known/oauth-authorization-server');
    expect(as.json).toMatchObject({ code_challenge_methods_supported: ['S256'], registration_endpoint: `${ORIGIN}/oauth/register` });
    const bad = await req('POST', '/oauth/register', { body: { client_name: 'X', redirect_uris: ['http://evil.example/cb'] } });
    expect(bad.status).toBe(400);
  });

  it('kompletter OAuth-Ablauf mit PKCE, Freigabe und Refresh', async () => {
    const reg = await req('POST', '/oauth/register', { body: { client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' } });
    expect(reg.status).toBe(201);
    const clientId = reg.json.client_id as string;
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
      scope: 'tasks:read tasks:write',
      resource: `${ORIGIN}/mcp`,
    });

    // Ohne Anmeldung: weiter zum Login mit Rücksprung
    const saved = cookie;
    cookie = '';
    const noSession = await req('GET', `/oauth/authorize?${q}`);
    expect(noSession.status).toBe(302);
    expect(noSession.headers.location).toMatch(/^\/login\?next=%2Foauth%2Fauthorize/);
    cookie = saved;

    // Freigabeseite
    const consent = await req('GET', `/oauth/authorize?${q}`);
    expect(consent.status).toBe(200);
    expect(consent.body).toContain('Claude möchte auf Do-it zugreifen');
    const params = /name="params" value="([^"]+)"/.exec(consent.body)![1]!.replace(/&amp;/g, '&');
    const csrf = /name="csrf" value="([^"]+)"/.exec(consent.body)![1]!;
    const forged = await req('POST', '/oauth/authorize', { form: { params, csrf: 'falsch', decision: 'allow' } });
    expect(forged.status).toBe(400);
    const allow = await req('POST', '/oauth/authorize', { form: { params, csrf, decision: 'allow' } });
    expect(allow.status).toBe(302);
    const back = new URL(allow.headers.location as string);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('xyz');
    const code = back.searchParams.get('code')!;

    // Falscher Verifier scheitert, richtiger klappt, Code nur einmal nutzbar
    const wrong = await req('POST', '/oauth/token', { form: { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: 'x'.repeat(43) } });
    expect(wrong.status).toBe(400);
    const allow2 = await req('POST', '/oauth/authorize', { form: { params, csrf, decision: 'allow' } });
    const code2 = new URL(allow2.headers.location as string).searchParams.get('code')!;
    const tok = await req('POST', '/oauth/token', { form: { grant_type: 'authorization_code', code: code2, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier } });
    expect(tok.status).toBe(200);
    expect(tok.json).toMatchObject({ token_type: 'Bearer', scope: 'tasks:read tasks:write' });
    const again = await req('POST', '/oauth/token', { form: { grant_type: 'authorization_code', code: code2, client_id: clientId, code_verifier: verifier } });
    expect(again.status).toBe(400);

    // Refresh mit Rotation
    const ref = await req('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: tok.json.refresh_token as string, client_id: clientId } });
    expect(ref.status).toBe(200);
    const reuse = await req('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: tok.json.refresh_token as string, client_id: clientId } });
    expect(reuse.status).toBe(400);
    accessToken = ref.json.access_token as string;
    refreshToken = ref.json.refresh_token as string;
    expect(refreshToken).toMatch(/^doit_rt_/);
  });

  it('MCP: Werkzeuge auflisten, anlegen, Überblick, abhaken, Briefing', async () => {
    const client = await mcpClient(accessToken);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(['add_comment', 'add_tasks', 'complete_tasks', 'delete_task', 'find_tasks', 'get_completed', 'get_overview', 'list_projects', 'post_briefing', 'update_task']);
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(['tagesbriefing']);

    const added = textOf(
      await client.callTool({
        name: 'add_tasks',
        arguments: { tasks: [{ text: 'heute 23:30 Zahnarzt anrufen #Gesundheit !1' }, { text: 'jeden Montag Müll rausbringen' }, { text: 'Steuer machen' }] },
      }),
    );
    expect(added).toContain('„Zahnarzt anrufen“ angelegt');
    expect(added).toContain('#Gesundheit');
    expect(added).toContain('jeden Montag');
    const zahnarztId = /Zahnarzt anrufen“ angelegt.*\(id: ([0-9a-f-]{36})\)/.exec(added)![1]!;

    const overview = textOf(await client.callTool({ name: 'get_overview', arguments: {} }));
    expect(overview).toMatch(/## Heute \(1\)\n- Zahnarzt anrufen · fällig Heute 23:30 · P1 · #Gesundheit/);
    expect(overview).toContain('Gesundheit: 1 offen');
    expect(overview).toMatch(/## Karma\n- Stufe 1 \(Samenkorn\), 0 Punkte/);

    const found = textOf(await client.callTool({ name: 'find_tasks', arguments: { query: 'müll' } }));
    expect(found).toContain('Müll rausbringen');
    // Filtersprache
    const p1 = textOf(await client.callTool({ name: 'find_tasks', arguments: { filter: 'heute & p1' } }));
    expect(p1).toContain('Zahnarzt anrufen');
    expect(p1).not.toContain('Müll rausbringen');
    expect(textOf(await client.callTool({ name: 'find_tasks', arguments: { filter: '#Gesundheit | wiederkehrend' } }))).toMatch(/2 Treffer/);
    expect(textOf(await client.callTool({ name: 'find_tasks', arguments: { filter: 'heute &' } }))).toContain('Filter: Nach einer Verknüpfung fehlt noch etwas.');

    const upd = textOf(await client.callTool({ name: 'update_task', arguments: { id: zahnarztId, due: 'morgen 9 Uhr', priority: 2 } }));
    expect(upd).toContain('fällig Morgen 09:00');
    expect(upd).toContain('P2');

    const done = textOf(await client.callTool({ name: 'complete_tasks', arguments: { ids: [zahnarztId] } }));
    expect(done).toContain('„Zahnarzt anrufen“ erledigt');
    expect(textOf(await client.callTool({ name: 'get_completed', arguments: { days: 1 } }))).toContain('Zahnarzt anrufen');
    // Abhaken über Claude zählt fürs Karma
    expect(textOf(await client.callTool({ name: 'get_overview', arguments: {} }))).toMatch(/## Karma\n- Stufe 1 \(Samenkorn\), \d+ Punkte/);
    expect((await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM karma_events WHERE kind = 'done'`))!.n).toBe(1);

    sent.length = 0;
    const br = textOf(await client.callTool({ name: 'post_briefing', arguments: { text: '## Heute\n- **Steuer** machen' } }));
    expect(br).toContain('an 1 Gerät(e) geschickt');
    expect(sent[0]).toMatchObject({ title: 'Tagesbriefing', url: '/briefings' });
    const list = await req('GET', '/api/briefings');
    expect((list.json.briefings as { title: string; read: boolean }[])[0]).toMatchObject({ title: 'Tagesbriefing', read: false });

    // Die Aufgabe ist über den normalen Sync sichtbar
    const pull = await req('GET', '/api/sync/pull?cursor=0');
    const titles = (pull.json.objects as { type: string; data: { title?: string } }[]).filter((o) => o.type === 'task').map((o) => o.data.title);
    expect(titles).toEqual(expect.arrayContaining(['Zahnarzt anrufen', 'Müll rausbringen', 'Steuer machen']));
    void zonedParts;
    await client.close();
  });

  it('persönlicher Schlüssel und Trennen', async () => {
    const pat = await req('POST', '/api/tokens', { body: { name: 'Claude Code' } });
    expect(pat.json.token).toMatch(/^doit_pat_/);
    const client = await mcpClient(pat.json.token as string);
    expect(textOf(await client.callTool({ name: 'list_projects', arguments: {} }))).toContain('Eingang');
    await client.close();

    const conns = await req('GET', '/api/connections');
    const list = conns.json.connections as { id: string; kind: string; name: string }[];
    expect(list.map((c) => [c.kind, c.name]).sort()).toEqual([
      ['oauth', 'Claude'],
      ['token', 'Claude Code'],
    ]);
    for (const c of list) expect((await req('DELETE', `/api/connections/${c.id}`)).status).toBe(200);
    const after = await req('POST', '/mcp', {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      headers: { cookie: '', authorization: `Bearer ${accessToken}`, accept: 'application/json, text/event-stream' },
    });
    expect(after.status).toBe(401);
    const refresh = await req('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: refreshToken } });
    expect(refresh.status).toBe(401);
  });
});
