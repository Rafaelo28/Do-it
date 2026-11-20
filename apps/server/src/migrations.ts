import type { Db } from './db';

/** Datenbank-Migrationen. Nur anhängen, niemals bestehende ändern. */
const MIGRATIONS: string[] = [
  /* 1: Grundschema */ `
  CREATE TABLE users (
    id uuid PRIMARY KEY,
    email text NOT NULL UNIQUE,
    name text NOT NULL,
    password_hash text NOT NULL,
    timezone text NOT NULL DEFAULT 'Europe/Berlin',
    settings jsonb NOT NULL DEFAULT '{}',
    is_admin boolean NOT NULL DEFAULT false,
    ical_token text UNIQUE,
    last_briefing_date date,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE sessions (
    token_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    user_agent text
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE SEQUENCE sync_seq;

  CREATE TABLE objects (
    id uuid PRIMARY KEY,
    type text NOT NULL,
    project_id uuid,
    owner_id uuid REFERENCES users(id) ON DELETE CASCADE,
    data jsonb NOT NULL,
    clock jsonb NOT NULL DEFAULT '{}',
    deleted boolean NOT NULL DEFAULT false,
    seq bigint NOT NULL DEFAULT nextval('sync_seq'),
    created_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX objects_seq ON objects(seq);
  CREATE INDEX objects_project ON objects(project_id, seq);
  CREATE INDEX objects_owner ON objects(owner_id, seq);
  CREATE INDEX objects_task_ref ON objects((data->>'taskId')) WHERE type IN ('reminder', 'comment');
  CREATE INDEX objects_parent_ref ON objects((data->>'parentId')) WHERE type = 'task';

  CREATE TABLE project_members (
    project_id uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, user_id)
  );
  CREATE INDEX project_members_user ON project_members(user_id);

  CREATE TABLE applied_mutations (
    mid text PRIMARY KEY,
    user_id uuid NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE invites (
    id uuid PRIMARY KEY,
    token_hash text NOT NULL UNIQUE,
    created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id uuid,
    role text NOT NULL DEFAULT 'editor',
    expires_at timestamptz NOT NULL,
    used_by uuid,
    used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE push_subscriptions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint text NOT NULL UNIQUE,
    p256dh text NOT NULL,
    auth text NOT NULL,
    user_agent text,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_success_at timestamptz,
    failures int NOT NULL DEFAULT 0
  );

  CREATE TABLE reminder_schedule (
    reminder_id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    task_id uuid NOT NULL,
    fire_at timestamptz NOT NULL,
    sent_at timestamptz,
    locked_until timestamptz
  );
  CREATE INDEX reminder_schedule_due ON reminder_schedule(fire_at) WHERE sent_at IS NULL;
  CREATE INDEX reminder_schedule_task ON reminder_schedule(task_id);

  CREATE TABLE activity (
    id bigserial PRIMARY KEY,
    project_id uuid,
    user_id uuid,
    kind text NOT NULL,
    object_id uuid,
    summary text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX activity_project ON activity(project_id, id);

  CREATE TABLE server_kv (
    key text PRIMARY KEY,
    value text NOT NULL
  );
  `,
  /* 2: Claude-Anbindung (OAuth, Zugangsschlüssel, Briefings) */ `
  CREATE TABLE oauth_clients (
    id text PRIMARY KEY,
    secret_hash text,
    name text NOT NULL,
    redirect_uris jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE oauth_codes (
    code_hash text PRIMARY KEY,
    client_id text NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redirect_uri text NOT NULL,
    code_challenge text NOT NULL,
    scope text NOT NULL,
    expires_at timestamptz NOT NULL
  );

  CREATE TABLE api_tokens (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('personal', 'access', 'refresh')),
    name text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    client_id text REFERENCES oauth_clients(id) ON DELETE CASCADE,
    grant_id uuid,
    scope text NOT NULL,
    expires_at timestamptz,
    last_used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX api_tokens_user ON api_tokens(user_id);
  CREATE INDEX api_tokens_grant ON api_tokens(grant_id);

  CREATE TABLE briefings (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title text NOT NULL,
    body text NOT NULL,
    source text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    read_at timestamptz
  );
  CREATE INDEX briefings_user ON briefings(user_id, created_at DESC);
  `,
];

export async function migrate(db: Db): Promise<number> {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  return db.tx(async (q) => {
    await q.query('SELECT pg_advisory_xact_lock(171717)');
    const rows = await q.query<{ version: number }>('SELECT version FROM schema_migrations');
    const done = new Set(rows.map((r) => r.version));
    let applied = 0;
    for (let i = 0; i < MIGRATIONS.length; i++) {
      const version = i + 1;
      if (done.has(version)) continue;
      await q.query(MIGRATIONS[i]!);
      await q.query('INSERT INTO schema_migrations(version) VALUES ($1)', [version]);
      applied++;
    }
    return applied;
  });
}
