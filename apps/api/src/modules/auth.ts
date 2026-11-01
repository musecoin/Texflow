import crypto from 'node:crypto';
import { AppError, LoginReq, RefreshReq } from '@texflow/shared';
import type { Pool, Connection } from '@texflow/db';
import type { Route, PublicCtx } from '../http/kernel.ts';
import type { Config } from '../config.ts';
import { verifyPassword, burnPasswordCheck, newToken, sha256 } from '@texflow/db';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export async function withOrg<T>(pool: Pool, orgId: string, fn: (db: Connection) => Promise<T>): Promise<T> {
  return pool.transaction(async (db) => {
    await db.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    return fn(db);
  });
}

async function issueSession(db: Connection, cfg: Config, a: { orgId: string; userId: string; familyId: string; ip: string; ua: string }) {
  const access = newToken(); const refresh = newToken();
  const accessExp = new Date(Date.now() + cfg.accessTtlMin * 60_000);
  const refreshExp = new Date(Date.now() + cfg.refreshTtlDays * 86_400_000);
  await db.query(
    `INSERT INTO user_session (organization_id, user_id, family_id, access_hash, refresh_hash, access_expires_at, refresh_expires_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [a.orgId, a.userId, a.familyId, sha256(access), sha256(refresh), accessExp, refreshExp, a.ip, a.ua]);
  return { accessToken: access, refreshToken: refresh, accessExpiresAt: accessExp.toISOString(), refreshExpiresAt: refreshExp.toISOString(), tokenType: 'Bearer' };
}

async function audit(db: Connection, orgId: string, userId: string | null, action: string, ctx: PublicCtx, after?: unknown) {
  await db.query(`INSERT INTO audit_event (organization_id, actor_user_id, action, entity_type, entity_id, after_state, request_id, ip) VALUES ($1,$2,$3,'user',$2,$4,$5,$6)`,
    [orgId, userId, action, after ?? null, ctx.requestId, ctx.ip]);
}

export function authRoutes(cfg: Config): Route[] {
  return [
    {
      method: 'POST', path: '/api/v1/auth/login', tag: 'auth', summary: 'Giriş (e-posta + şifre)', public: true, body: LoginReq,
      rateLimitKey: (c) => `login:${String(c.body?.organizationCode).toLowerCase()}:${String(c.body?.email).toLowerCase()}`,
      handler: async (c) => {
        const { organizationCode, email, password } = c.body;
        const u = (await c.pool.query<{ user_id: string; organization_id: string; password_hash: string; is_active: boolean; locked_until: string | null; failed_logins: number }>(
          'SELECT * FROM tf_auth_find_user($1, $2)', [organizationCode, email])).rows[0];
        if (!u) { await burnPasswordCheck(password); throw new AppError('INVALID_CREDENTIALS', 'Kullanıcı adı veya şifre hatalı'); }
        if (u.locked_until && new Date(u.locked_until) > new Date()) throw new AppError('ACCOUNT_LOCKED', 'Hesap geçici olarak kilitlendi');
        const ok = u.is_active && (await verifyPassword(password, u.password_hash));
        return withOrg(c.pool, u.organization_id, async (db) => {
          if (!ok) {
            const failed = u.failed_logins + 1;
            await db.query(`UPDATE app_user SET failed_logins = $2::int, locked_until = CASE WHEN $2::int >= $3::int THEN now() + make_interval(mins => $4::int) ELSE locked_until END WHERE id = $1`,
              [u.user_id, failed, MAX_FAILED, LOCK_MINUTES]);
            await audit(db, u.organization_id, u.user_id, 'auth.login_failed', c, { failed });
            return { __fail: true } as const;
          }
          await db.query('UPDATE app_user SET failed_logins = 0, locked_until = NULL WHERE id = $1', [u.user_id]);
          const tokens = await issueSession(db, cfg, { orgId: u.organization_id, userId: u.user_id, familyId: crypto.randomUUID(), ip: c.ip, ua: c.userAgent });
          await audit(db, u.organization_id, u.user_id, 'auth.login', c);
          return tokens;
        }).then((r) => { if ('__fail' in r) throw new AppError('INVALID_CREDENTIALS', 'Kullanıcı adı veya şifre hatalı'); return r; });
      },
    },
    {
      method: 'POST', path: '/api/v1/auth/refresh', tag: 'auth', summary: 'Token yenileme (rotasyon + yeniden kullanım tespiti)', public: true, body: RefreshReq,
      rateLimitKey: (c) => 'refresh:' + c.ip,
      handler: async (c) => {
        const h = sha256(c.body.refreshToken);
        const s = (await c.pool.query<{ session_id: string; organization_id: string; user_id: string; family_id: string; refresh_expires_at: string; rotated_at: string | null; revoked_at: string | null }>(
          'SELECT * FROM tf_auth_find_refresh($1)', [h])).rows[0];
        if (!s) throw new AppError('UNAUTHENTICATED', 'Geçersiz yenileme anahtarı');
        const res = await withOrg(c.pool, s.organization_id, async (db) => {
          // lock the row so two concurrent refreshes cannot both rotate
          const cur = (await db.query<{ rotated_at: string | null; revoked_at: string | null }>('SELECT rotated_at, revoked_at FROM user_session WHERE id = $1 FOR UPDATE', [s.session_id])).rows[0];
          if (cur.rotated_at || cur.revoked_at) {
            await db.query(`UPDATE user_session SET revoked_at = coalesce(revoked_at, now()), revoke_reason = coalesce(revoke_reason, 'REFRESH_REUSE') WHERE family_id = $1`, [s.family_id]);
            await audit(db, s.organization_id, s.user_id, 'auth.refresh_reuse_detected', c, { familyId: s.family_id });
            return { reused: true } as const;
          }
          if (new Date(s.refresh_expires_at) <= new Date()) return { expired: true } as const;
          await db.query(`UPDATE user_session SET rotated_at = now(), revoked_at = now(), revoke_reason = 'ROTATED' WHERE id = $1`, [s.session_id]);
          return issueSession(db, cfg, { orgId: s.organization_id, userId: s.user_id, familyId: s.family_id, ip: c.ip, ua: c.userAgent });
        });
        if ('reused' in res) throw new AppError('REFRESH_TOKEN_REUSED', 'Yenileme anahtarı tekrar kullanıldı; tüm oturumlar kapatıldı');
        if ('expired' in res) throw new AppError('TOKEN_EXPIRED', 'Yenileme süresi doldu');
        return res;
      },
    },
    {
      method: 'POST', path: '/api/v1/auth/logout', tag: 'auth', summary: 'Oturumu kapat', permission: null, idempotent: false,
      handler: async (c) => {
        await c.db.query(`UPDATE user_session SET revoked_at = now(), revoke_reason = 'LOGOUT' WHERE id = $1`, [c.auth.sessionId]);
        await c.audit('auth.logout', 'user', c.auth.userId, null, null);
        return { status: 200, body: { ok: true } };
      },
    },
    {
      method: 'GET', path: '/api/v1/auth/me', tag: 'auth', summary: 'Oturumdaki kullanıcı, yetkiler ve fabrikalar', permission: null,
      handler: async (c) => {
        const u = (await c.db.query(`SELECT u.id, u.email, u.display_name, u.locale, o.id AS org_id, o.code AS org_code, o.name AS org_name, o.base_currency, o.is_demo, o.timezone
                                       FROM app_user u JOIN organization o ON o.id = u.organization_id WHERE u.id = $1`, [c.auth.userId])).rows[0];
        const roles = (await c.db.query('SELECT r.code, r.name, ur.factory_id FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.code', [c.auth.userId])).rows;
        const factories = (await c.db.query('SELECT id, code, name FROM factory WHERE is_active ORDER BY code')).rows
          .filter((f) => !c.auth.factoryIds || c.auth.factoryIds.has(f.id));
        return {
          user: { id: u.id, email: u.email, displayName: u.display_name, locale: u.locale },
          organization: { id: u.org_id, code: u.org_code, name: u.org_name, baseCurrency: u.base_currency, isDemo: u.is_demo, timezone: u.timezone },
          roles, factories, permissions: [...c.auth.permissions].sort(),
        };
      },
    },
  ];
}
