import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),
  APP_URL: z.string().url().default('http://localhost:8080'),
  /** zusätzliche erlaubte Origins (z. B. Vite-Dev-Server), kommagetrennt */
  ALLOWED_ORIGINS: z.string().default(''),
  AUTH_SECRET: z.string().min(32).optional(),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
  WEB_DIST: z.string().optional(),
  /** Erinnerungs-Dienst im selben Prozess laufen lassen (praktisch für Entwicklung) */
  RUN_WORKER: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  WORKER_INTERVAL_MS: z.coerce.number().int().min(1000).default(20000),
  LOG_LEVEL: z.string().default('info'),
  /** fester Einrichtungscode (sonst zufällig erzeugt und im Log angezeigt) */
  SETUP_CODE: z.string().min(6).max(64).optional(),
  /** Anfragen pro Minute und IP auf /api, /oauth und /mcp */
  RATE_LIMIT_PER_MIN: z.coerce.number().int().min(30).default(600),
});

export type Config = z.infer<typeof schema> & { origins: string[]; secureCookies: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Leere Werte (z. B. aus "${VAR:-}" in docker-compose) wie nicht gesetzt behandeln
  const parsed = schema.parse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')));
  const appOrigin = new URL(parsed.APP_URL).origin;
  const origins = [appOrigin, ...parsed.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)];
  return { ...parsed, origins, secureCookies: appOrigin.startsWith('https:') };
}
