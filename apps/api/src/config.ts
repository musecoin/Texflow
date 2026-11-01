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
    ...overrides,
  };
}
