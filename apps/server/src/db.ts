import pg from 'pg';

// Datum-Spalten als Text lassen ("2026-11-20"), keine JS-Date-Umwandlung mit Zeitzonen-Fallen.
pg.types.setTypeParser(1082, (v) => v);
// bigint (seq) als Zahl; reicht für viele Millionen Änderungen.
pg.types.setTypeParser(20, (v) => Number(v));

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  pool: pg.Pool;
}

function wrap(client: pg.Pool | pg.PoolClient): Queryable {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await client.query(sql, params);
      return res.rows as T[];
    },
    async one<T>(sql: string, params: unknown[] = []) {
      const res = await client.query(sql, params);
      return (res.rows[0] as T) ?? null;
    },
  };
}

export function createDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10 });
  const base = wrap(pool);
  return {
    ...base,
    pool,
    async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Alle Schreibzugriffe auf objects laufen unter dieser Sperre, damit seq lückenlos in Commit-Reihenfolge steigt. */
export async function lockObjects(q: Queryable): Promise<void> {
  await q.query('SELECT pg_advisory_xact_lock(424242)');
}
