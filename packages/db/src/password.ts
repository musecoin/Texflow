import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** scrypt$N$r$p$salt$hash (base64). */
export async function hashPassword(pw: string): Promise<string> {
  if (pw.length < 8) throw new Error('password too short');
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw.normalize('NFKC'), salt, 64, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${h.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const h = await scrypt(pw.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(h, expected);
}

/** Constant work for unknown users so response time does not reveal account existence. */
let dummy: string | null = null;
export async function burnPasswordCheck(pw: string): Promise<void> {
  dummy ??= await hashPassword('timing-equaliser-' + crypto.randomUUID());
  await verifyPassword(pw, dummy);
}

export function newToken(): string { return crypto.randomBytes(32).toString('base64url'); }
export function sha256(s: string): string { return crypto.createHash('sha256').update(s).digest('hex'); }
