/**
 * Forward-only SQL migrator.
 *   node packages/db/src/migrate.ts            apply pending migrations
 *   node packages/db/src/migrate.ts --reset    DROP and recreate schema (refused in production)
 *
 * Uses DATABASE_URL (schema owner) to run DDL and APP_DATABASE_URL to (re)create the
 * least-privilege application role. Applied files are checksummed; editing an already
 * applied migration is detected and refused.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Connection, parseDatabaseUrl } from './pg.ts';
import { loadDbEnv } from './env.ts';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

function ident(s: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`unsafe identifier: ${s}`);
  return `"${s}"`;
}
function literal(s: string): string { return `'${s.replace(/'/g, "''")}'`; }

export async function migrate(opts: { reset?: boolean; log?: (m: string) => void } = {}): Promise<string[]> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const env = loadDbEnv();
  const owner = parseDatabaseUrl(env.DATABASE_URL);
  const app = parseDatabaseUrl(env.APP_DATABASE_URL);
  if (app.user !== 'texflow_app') throw new Error('APP_DATABASE_URL must use the role texflow_app');

  // 1. ensure database exists
  const admin = new Connection({ ...owner, database: 'postgres' });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [owner.database]);
    if (!exists.rowCount) { await admin.query(`CREATE DATABASE ${ident(owner.database)}`); log(`created database ${owner.database}`); }
    const role = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [app.user]);
    const pw = literal(app.password ?? '');
    if (!role.rowCount) await admin.query(`CREATE ROLE texflow_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${pw}`);
    else await admin.query(`ALTER ROLE texflow_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pw}`);
  } finally { await admin.end(); }

  const c = new Connection(owner);
  await c.connect();
  const applied: string[] = [];
  try {
    if (opts.reset) {
      if (process.env.NODE_ENV === 'production') throw new Error('--reset refused in production');
      await c.query('DROP SCHEMA IF EXISTS public CASCADE');
      await c.query('CREATE SCHEMA public');
      log('schema reset');
    }
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    await c.query(`REVOKE ALL ON schema_migrations FROM texflow_app`);
    const done = new Map((await c.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      const sum = crypto.createHash('sha256').update(sql).digest('hex');
      if (done.has(f)) {
        if (done.get(f) !== sum) throw new Error(`migration ${f} was modified after being applied`);
        continue;
      }
      await c.query('BEGIN');
      try {
        for (const stmt of splitSql(sql)) await c.query(stmt);
        await c.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [f, sum]);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK'); throw new Error(`migration ${f} failed: ${(e as Error).message}`); }
      applied.push(f);
      log(`applied ${f}`);
    }
    if (!applied.length) log('database is up to date');
  } finally { await c.end(); }
  return applied;
}

/** Splits a SQL script on top-level semicolons, respecting quotes, comments and $$ bodies. */
export function splitSql(sql: string): string[] {
  const out: string[] = []; let cur = ''; let i = 0;
  let dollar: string | null = null; let quote = false;
  while (i < sql.length) {
    const ch = sql[i];
    if (dollar) {
      if (sql.startsWith(dollar, i)) { cur += dollar; i += dollar.length; dollar = null; continue; }
      cur += ch; i++; continue;
    }
    if (quote) { cur += ch; if (ch === "'") quote = false; i++; continue; }
    if (ch === '-' && sql[i + 1] === '-') { const e = sql.indexOf('\n', i); i = e === -1 ? sql.length : e + 1; cur += '\n'; continue; }
    if (ch === "'") { quote = true; cur += ch; i++; continue; }
    if (ch === '$') { const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i)); if (m) { dollar = m[0]; cur += dollar; i += dollar.length; continue; } }
    if (ch === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate({ reset: process.argv.includes('--reset') }).then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
}
