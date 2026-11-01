import fs from 'node:fs';
import path from 'node:path';

/** Loads .env from the repo root if present (without overriding real env vars). */
export function loadDotEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const f = path.join(dir, '.env');
    if (fs.existsSync(f)) {
      for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
        if (!m || line.trimStart().startsWith('#')) continue;
        if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
      }
      return;
    }
    const up = path.dirname(dir); if (up === dir) return; dir = up;
  }
}

export function loadDbEnv(): { DATABASE_URL: string; APP_DATABASE_URL: string } {
  loadDotEnv();
  const DATABASE_URL = process.env.DATABASE_URL;
  const APP_DATABASE_URL = process.env.APP_DATABASE_URL;
  if (!DATABASE_URL || !APP_DATABASE_URL) throw new Error('DATABASE_URL and APP_DATABASE_URL must be set (see .env.example)');
  return { DATABASE_URL, APP_DATABASE_URL };
}
