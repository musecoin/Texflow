import { AppError } from '@texflow/shared';
import type { Connection } from '@texflow/db';
import type { Ctx } from './http/kernel.ts';

/** Gap-free, per-organization document numbers (row lock serializes concurrent callers). */
export async function nextNumber(db: Connection, orgId: string, name: string, prefix: string, width = 5): Promise<string> {
  await db.query(`INSERT INTO number_sequence (organization_id, name, prefix) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [orgId, name, prefix]);
  const r = await db.query<{ v: string; prefix: string }>(
    `UPDATE number_sequence SET next_value = next_value + 1 WHERE organization_id = $1 AND name = $2 RETURNING next_value - 1 AS v, prefix`, [orgId, name]);
  return `${r.rows[0].prefix}-${String(r.rows[0].v).padStart(width, '0')}`;
}

export async function one<R extends Record<string, any>>(db: Connection, sql: string, params: unknown[], what = 'Kayıt'): Promise<R> {
  const r = await db.query<R>(sql, params);
  if (!r.rows[0]) throw new AppError('NOT_FOUND', `${what} bulunamadı`);
  return r.rows[0];
}

export function assertUuid(id: string, what = 'Kayıt') {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new AppError('NOT_FOUND', `${what} bulunamadı`);
}

/** Applies a state change only if the row is still at the version the client saw. */
export async function updateVersioned(db: Connection, table: string, id: string, expectedVersion: number, set: Record<string, unknown>): Promise<Record<string, any>> {
  if (!/^[a-z_]+$/.test(table)) throw new Error('bad table');
  const keys = Object.keys(set);
  keys.forEach((k) => { if (!/^[a-z_]+$/.test(k)) throw new Error('bad column'); });
  const assignments = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
  const r = await db.query(`UPDATE ${table} SET ${assignments}${assignments ? ', ' : ''}row_version = row_version + 1 WHERE id = $1 AND row_version = $2 RETURNING *`,
    [id, expectedVersion, ...keys.map((k) => set[k])]);
  if (!r.rowCount) {
    const cur = await db.query<{ row_version: number }>(`SELECT row_version FROM ${table} WHERE id = $1`, [id]);
    if (!cur.rowCount) throw new AppError('NOT_FOUND', 'Kayıt bulunamadı');
    throw new AppError('VERSION_CONFLICT', 'Kayıt başka biri tarafından değiştirildi; güncel hali yükleyip tekrar deneyin', { expectedVersion, currentVersion: cur.rows[0].row_version });
  }
  return r.rows[0];
}

export function page<T>(rows: T[], total: number, q: { limit: number; offset: number }) {
  return { items: rows, page: { total, limit: q.limit, offset: q.offset, hasMore: q.offset + rows.length < total } };
}

/** Whitelisted ORDER BY. `sort` like "-due_date" or "order_no". */
export function orderBy(sort: string | undefined, allowed: string[], fallback: string): string {
  if (!sort) return fallback;
  const desc = sort.startsWith('-'); const col = desc ? sort.slice(1) : sort;
  if (!allowed.includes(col)) throw new AppError('VALIDATION_FAILED', `sıralama alanı desteklenmiyor: ${col}`);
  return `${col} ${desc ? 'DESC' : 'ASC'}`;
}

// DB rows are untyped at this boundary; response shapes are covered by integration tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function camel<T extends Record<string, any>>(row: T): any {
  const o: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) o[k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())] = v;
  return o;
}
export const camelAll = (rows: Record<string, any>[]): any[] => rows.map(camel);

export type { Ctx };
