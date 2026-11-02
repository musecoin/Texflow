import { loadDotEnv } from '@texflow/db';

export interface Config {
  env: 'development' | 'test' | 'production';
  host: string; port: number;
  appDatabaseUrl: string;
  corsOrigins: string[];
  accessTtlMin: number; refreshTtlDays: number;
  loginRatePerMin: number; apiRatePerMin: number;
  webDistDir: string | null;
  maxBodyBytes: number;
  trustProxy: boolean;
  /** AI document reading (photo → order draft). Disabled when no key is set. */
  ai: { apiKey: string | null; model: string; baseUrl: string; perHour: number; timeoutMs: number };
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  loadDotEnv();
  const e = process.env;
  const env = (e.NODE_ENV === 'production' ? 'production' : e.NODE_ENV === 'test' ? 'test' : 'development') as Config['env'];
  const appDatabaseUrl = overrides.appDatabaseUrl ?? e.APP_DATABASE_URL;
  if (!appDatabaseUrl) throw new Error('APP_DATABASE_URL is required');
  if (env === 'production' && /_dev_only/.test(appDatabaseUrl)) throw new Error('refusing to start in production with development credentials');
  return {
    env,
    host: e.HOST ?? '0.0.0.0',
    port: Number(e.PORT ?? 8080),
    appDatabaseUrl,
    corsOrigins: (e.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    accessTtlMin: Number(e.ACCESS_TOKEN_TTL_MIN ?? 30),
    refreshTtlDays: Number(e.REFRESH_TOKEN_TTL_DAYS ?? 14),
    loginRatePerMin: Number(e.LOGIN_RATE_LIMIT_PER_MIN ?? 10),
    apiRatePerMin: Number(e.API_RATE_LIMIT_PER_MIN ?? 600),
    webDistDir: e.WEB_DIST_DIR ?? null,
    maxBodyBytes: 1_000_000,
    trustProxy: e.TRUST_PROXY === '1',
    ai: {
      apiKey: e.ANTHROPIC_API_KEY?.trim() || null,
      model: e.AI_MODEL ?? 'claude-sonnet-5-5',
      baseUrl: (e.AI_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, ''),
      perHour: Number(e.AI_RATE_PER_HOUR ?? 30),
      timeoutMs: Number(e.AI_TIMEOUT_MS ?? 90_000),
    },
    ...overrides,
  };
}
