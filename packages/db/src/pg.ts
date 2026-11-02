/**
 * Minimal, dependency-free PostgreSQL client (wire protocol v3).
 *
 * Why this exists: the build sandbox for Phase 0 had no npm registry access, so `pg`
 * and Prisma could not be installed. This client implements exactly what the
 * application needs: SCRAM-SHA-256/MD5/cleartext auth, optional TLS, the extended
 * query protocol with server-side parameter binding (no string interpolation of
 * values, so no SQL injection), typed row decoding, a connection pool and
 * transactions. NUMERIC values are always returned as strings to stay decimal-safe.
 *
 * The data-access layer only depends on the small `Queryable` interface below, so it
 * can be swapped for `pg` / Prisma without touching business logic.
 */
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

export type Row = Record<string, any>;
export interface QueryResult<R extends Row = Row> { rows: R[]; rowCount: number; command: string }
export interface Queryable {
  query<R extends Row = Row>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
}

export class PgError extends Error {
  code: string;
  detail?: string;
  constraint?: string;
  table?: string;
  severity?: string;
  constructor(fields: Record<string, string>) {
    super(fields.M ?? 'PostgreSQL error');
    this.name = 'PgError';
    this.code = fields.C ?? 'XX000';
    this.detail = fields.D;
    this.constraint = fields.n;
    this.table = fields.t;
    this.severity = fields.V ?? fields.S;
  }
}

export interface PgConfig {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
  ssl?: boolean | tls.ConnectionOptions;
  applicationName?: string;
  connectTimeoutMs?: number;
}

export function parseDatabaseUrl(url: string): PgConfig {
  const u = new URL(url);
  const sslmode = u.searchParams.get('sslmode');
  return {
    host: decodeURIComponent(u.hostname) || '127.0.0.1',
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
    // require = encrypted (no CA check, like libpq); verify-full = encrypted + certificate verified. SNI is always sent (Neon routes by it).
    ssl: sslmode === 'verify-full' ? true : sslmode === 'require' || sslmode === 'verify-ca' ? { rejectUnauthorized: false } : false,
  };
}

// ---- type decoding -------------------------------------------------------------------
const OID = { bool: 16, int8: 20, int2: 21, int4: 23, oid: 26, json: 114, float4: 700, float8: 701, jsonb: 3802, numeric: 1700,
  textArr: 1009, uuidArr: 2951, varcharArr: 1015, int4Arr: 1007, timestamptz: 1184, timestamp: 1114, date: 1082 };

function parseTextArray(s: string): (string | null)[] {
  // handles {a,b,"c d",NULL}
  if (s === '{}') return [];
  const out: (string | null)[] = [];
  let i = 1; let cur = ''; let quoted = false; let wasQuoted = false;
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '\\') { cur += s[i + 1]; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      cur += ch; i++; continue;
    }
    if (ch === '"') { quoted = true; wasQuoted = true; i++; continue; }
    if (ch === ',' || ch === '}') { out.push(!wasQuoted && cur === 'NULL' ? null : cur); cur = ''; wasQuoted = false; i++; continue; }
    cur += ch; i++;
  }
  return out;
}

function decode(oid: number, v: string): unknown {
  switch (oid) {
    case OID.bool: return v === 't';
    case OID.int2: case OID.int4: case OID.oid: return Number(v);
    case OID.float4: case OID.float8: return Number(v);
    case OID.json: case OID.jsonb: return JSON.parse(v);
    case OID.timestamptz: return new Date(v.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')).toISOString();
    case OID.timestamp: return new Date(v.replace(' ', 'T') + 'Z').toISOString();
    case OID.textArr: case OID.uuidArr: case OID.varcharArr: return parseTextArray(v);
    case OID.int4Arr: return parseTextArray(v).map((x) => (x === null ? null : Number(x)));
    // int8 and numeric deliberately stay strings (no float rounding)
    default: return v;
  }
}

function encodeParam(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'boolean') return v ? 't' : 'f';
  if (Array.isArray(v)) return '{' + v.map((x) => (x === null ? 'NULL' : '"' + String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"')).join(',') + '}';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ---- message building ----------------------------------------------------------------
function cstr(s: string): Buffer { return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]); }
function msg(type: string | null, body: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeInt32BE(body.length + 4);
  return type ? Buffer.concat([Buffer.from(type), len, body]) : Buffer.concat([len, body]);
}
function int16(n: number): Buffer { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; }
function int32(n: number): Buffer { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; }

interface Field { name: string; oid: number }
interface Pending { resolve: (r: QueryResult) => void; reject: (e: Error) => void; fields: Field[]; rows: Row[]; command: string; error?: PgError }

export class Connection implements Queryable {
  private socket!: net.Socket;
  private buf: Buffer = Buffer.alloc(0);
  private queue: Pending[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private readyResolve?: () => void;
  private readyReject?: (e: Error) => void;
  private scram?: { nonce: string; clientFirstBare: string; serverSignature?: Buffer };
  private cfg: PgConfig;
  closed = false;
  onError?: (e: Error) => void;

  constructor(cfg: PgConfig) { this.cfg = cfg; }

  async connect(): Promise<void> {
    const raw = net.connect({ host: this.cfg.host, port: this.cfg.port });
    raw.setNoDelay(true);
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => { raw.destroy(); rej(new Error('PostgreSQL connect timeout')); }, this.cfg.connectTimeoutMs ?? 10_000);
      raw.once('connect', () => { clearTimeout(t); res(); });
      raw.once('error', (e) => { clearTimeout(t); rej(e); });
    });
    let sock: net.Socket = raw;
    if (this.cfg.ssl) {
      raw.write(msg(null, int32(80877103)));
      const answer = await new Promise<string>((res, rej) => { raw.once('data', (d) => res(d.toString('utf8', 0, 1))); raw.once('error', rej); });
      if (answer !== 'S') throw new Error('Server refused TLS');
      const opts: tls.ConnectionOptions = { servername: net.isIP(this.cfg.host) ? undefined : this.cfg.host, ...(typeof this.cfg.ssl === 'object' ? this.cfg.ssl : {}) };
      sock = tls.connect({ ...opts, socket: raw });
      await new Promise<void>((res, rej) => { (sock as tls.TLSSocket).once('secureConnect', () => res()); sock.once('error', rej); });
    }
    this.socket = sock;
    sock.on('data', (d: Buffer) => this.onData(d));
    sock.on('error', (e) => this.fail(e));
    sock.on('close', () => { if (!this.closed) this.fail(new Error('PostgreSQL connection closed')); });

    const ready = new Promise<void>((res, rej) => { this.readyResolve = res; this.readyReject = rej; });
    const params = Buffer.concat([
      int32(196608),
      cstr('user'), cstr(this.cfg.user),
      cstr('database'), cstr(this.cfg.database),
      cstr('application_name'), cstr(this.cfg.applicationName ?? 'texflow'),
      cstr('client_encoding'), cstr('UTF8'),
      cstr('TimeZone'), cstr('UTC'),
      Buffer.from([0]),
    ]);
    sock.write(msg(null, params));
    await ready;
  }

  private fail(e: Error) {
    this.closed = true;
    this.readyReject?.(e);
    this.readyReject = undefined;
    for (const p of this.queue.splice(0)) p.reject(e);
    this.onError?.(e);
  }

  private onData(d: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 5) {
      const type = String.fromCharCode(this.buf[0]);
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < len + 1) break;
      const body = this.buf.subarray(5, len + 1);
      this.buf = this.buf.subarray(len + 1);
      try { this.handle(type, body); } catch (e) { this.fail(e as Error); this.socket.destroy(); return; }
    }
  }

  private handle(type: string, body: Buffer) {
    const cur = this.queue[0];
    switch (type) {
      case 'R': return this.handleAuth(body);
      case 'S': case 'K': case 'N': case 'A': case '1': case '2': case 'n': case 's': return;
      case 'Z':
        if (this.readyResolve) { const r = this.readyResolve; this.readyResolve = undefined; this.readyReject = undefined; r(); return; }
        if (cur) {
          this.queue.shift();
          if (cur.error) cur.reject(cur.error); else cur.resolve({ rows: cur.rows, rowCount: cur.rows.length || parseCount(cur.command), command: cur.command });
        }
        return;
      case 'T': {
        if (!cur) return;
        const n = body.readInt16BE(0); let off = 2; const fields: Field[] = [];
        for (let i = 0; i < n; i++) {
          const end = body.indexOf(0, off); const name = body.toString('utf8', off, end); off = end + 1;
          const oid = body.readInt32BE(off + 6); off += 18; fields.push({ name, oid });
        }
        cur.fields = fields; return;
      }
      case 'D': {
        if (!cur) return;
        const n = body.readInt16BE(0); let off = 2; const row: Row = {};
        for (let i = 0; i < n; i++) {
          const l = body.readInt32BE(off); off += 4; const f = cur.fields[i];
          if (l === -1) { row[f.name] = null; continue; }
          row[f.name] = decode(f.oid, body.toString('utf8', off, off + l)); off += l;
        }
        cur.rows.push(row); return;
      }
      case 'C': if (cur) cur.command = body.toString('utf8', 0, body.length - 1); return;
      case 'I': return;
      case 'E': {
        const fields: Record<string, string> = {}; let off = 0;
        while (off < body.length && body[off] !== 0) { const k = String.fromCharCode(body[off]); const end = body.indexOf(0, off + 1); fields[k] = body.toString('utf8', off + 1, end); off = end + 1; }
        const err = new PgError(fields);
        if (this.readyReject) { const r = this.readyReject; this.readyResolve = undefined; this.readyReject = undefined; r(err); return; }
        if (cur) cur.error = err; return;
      }
      default: return;
    }
  }

  private handleAuth(body: Buffer) {
    const code = body.readInt32BE(0);
    const pw = this.cfg.password ?? '';
    if (code === 0) return;
    if (code === 3) { this.socket.write(msg('p', cstr(pw))); return; }
    if (code === 5) {
      const salt = body.subarray(4, 8);
      const inner = crypto.createHash('md5').update(pw + this.cfg.user).digest('hex');
      const outer = 'md5' + crypto.createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex');
      this.socket.write(msg('p', cstr(outer))); return;
    }
    if (code === 10) {
      const mechs = body.toString('utf8', 4).split('\0');
      if (!mechs.includes('SCRAM-SHA-256')) throw new Error('No supported SASL mechanism');
      const nonce = crypto.randomBytes(18).toString('base64');
      const clientFirstBare = `n=*,r=${nonce}`;
      this.scram = { nonce, clientFirstBare };
      const first = Buffer.from('n,,' + clientFirstBare);
      this.socket.write(msg('p', Buffer.concat([cstr('SCRAM-SHA-256'), int32(first.length), first]))); return;
    }
    if (code === 11) {
      const s = this.scram!; const serverFirst = body.toString('utf8', 4);
      const attrs = Object.fromEntries(serverFirst.split(',').map((kv) => [kv[0], kv.slice(2)]));
      if (!attrs.r?.startsWith(s.nonce)) throw new Error('SCRAM nonce mismatch');
      const salted = crypto.pbkdf2Sync(pw.normalize('NFKC'), Buffer.from(attrs.s, 'base64'), Number(attrs.i), 32, 'sha256');
      const hmac = (k: Buffer, d: string) => crypto.createHmac('sha256', k).update(d).digest();
      const clientKey = hmac(salted, 'Client Key');
      const storedKey = crypto.createHash('sha256').update(clientKey).digest();
      const finalNoProof = `c=biws,r=${attrs.r}`;
      const authMessage = `${s.clientFirstBare},${serverFirst},${finalNoProof}`;
      const sig = hmac(storedKey, authMessage);
      const proof = Buffer.alloc(clientKey.length); for (let i = 0; i < proof.length; i++) proof[i] = clientKey[i] ^ sig[i];
      s.serverSignature = hmac(hmac(salted, 'Server Key'), authMessage);
      this.socket.write(msg('p', Buffer.from(`${finalNoProof},p=${proof.toString('base64')}`))); return;
    }
    if (code === 12) {
      const v = body.toString('utf8', 4).split(',').find((x) => x.startsWith('v='))?.slice(2);
      if (!v || !this.scram?.serverSignature || !crypto.timingSafeEqual(Buffer.from(v, 'base64'), this.scram.serverSignature)) throw new Error('SCRAM server signature mismatch');
      return;
    }
    throw new Error(`Unsupported auth method ${code}`);
  }

  query<R extends Row = Row>(text: string, params: unknown[] = []): Promise<QueryResult<R>> {
    const run = () => new Promise<QueryResult<R>>((resolve, reject) => {
      if (this.closed) return reject(new Error('PostgreSQL connection closed'));
      this.queue.push({ resolve: resolve as (r: QueryResult) => void, reject, fields: [], rows: [], command: '' });
      const enc = params.map(encodeParam);
      const parse = Buffer.concat([cstr(''), cstr(text), int16(0)]);
      const bindParts: Buffer[] = [cstr(''), cstr(''), int16(0), int16(enc.length)];
      for (const p of enc) {
        if (p === null) bindParts.push(int32(-1));
        else { const b = Buffer.from(p, 'utf8'); bindParts.push(int32(b.length), b); }
      }
      bindParts.push(int16(0));
      this.socket.write(Buffer.concat([
        msg('P', parse), msg('B', Buffer.concat(bindParts)), msg('D', Buffer.concat([Buffer.from('P'), cstr('')])),
        msg('E', Buffer.concat([cstr(''), int32(0)])), msg('S', Buffer.alloc(0)),
      ]));
    });
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  async end(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.write(msg('X', Buffer.alloc(0))); } catch { /* ignore */ }
    this.socket.end();
  }
}

function parseCount(cmd: string): number { const n = Number(cmd.split(' ').pop()); return Number.isFinite(n) ? n : 0; }

// ---- pool ----------------------------------------------------------------------------
export class Pool implements Queryable {
  private idle: Connection[] = [];
  private all = new Set<Connection>();
  private waiters: ((c: Connection) => void)[] = [];
  private cfg: PgConfig;
  private max: number;
  private ending = false;
  constructor(cfg: PgConfig, max = 10) { this.cfg = cfg; this.max = max; }

  async acquire(): Promise<Connection> {
    if (this.ending) throw new Error('Pool is closed');
    while (this.idle.length) { const c = this.idle.pop()!; if (!c.closed) return c; this.all.delete(c); }
    if (this.all.size < this.max) {
      const c = new Connection(this.cfg);
      this.all.add(c);
      c.onError = () => { this.all.delete(c); this.idle = this.idle.filter((x) => x !== c); };
      try { await c.connect(); } catch (e) { this.all.delete(c); throw e; }
      return c;
    }
    return new Promise((res) => this.waiters.push(res));
  }

  release(c: Connection, broken = false) {
    if (broken || c.closed) { this.all.delete(c); void c.end(); if (this.waiters.length) this.acquire().then(this.waiters.shift()!, () => undefined); return; }
    const w = this.waiters.shift();
    if (w) w(c); else this.idle.push(c);
  }

  async query<R extends Row = Row>(text: string, params?: unknown[]): Promise<QueryResult<R>> {
    const c = await this.acquire();
    try { return await c.query<R>(text, params); } finally { this.release(c); }
  }

  /** Runs fn inside BEGIN/COMMIT; rolls back on any error. */
  async transaction<T>(fn: (tx: Connection) => Promise<T>, opts: { isolation?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE' } = {}): Promise<T> {
    const c = await this.acquire();
    let broken = false;
    try {
      await c.query(`BEGIN ISOLATION LEVEL ${opts.isolation ?? 'READ COMMITTED'}`);
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch { broken = true; }
      throw e;
    } finally { this.release(c, broken); }
  }

  async end(): Promise<void> {
    this.ending = true;
    await Promise.all([...this.all].map((c) => c.end()));
    this.all.clear(); this.idle = [];
  }
}
