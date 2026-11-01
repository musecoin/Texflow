/**
 * Decimal-safe arithmetic for quantities and money. Values are fixed-point BigInts with
 * 10 fractional digits internally and are exchanged as strings (the same format
 * PostgreSQL NUMERIC uses). Never use JS floats for quantities or currency.
 */
const SCALE = 10;
const ONE = 10n ** BigInt(SCALE);

export class Dec {
  readonly v: bigint; // value * 10^SCALE
  private constructor(v: bigint) { this.v = v; }

  static of(x: string | number | bigint | Dec): Dec {
    if (x instanceof Dec) return x;
    if (typeof x === 'bigint') return new Dec(x * ONE);
    if (typeof x === 'number') {
      if (!Number.isFinite(x)) throw new RangeError('non-finite number');
      if (!Number.isInteger(x)) throw new TypeError('pass decimals as strings, not floats: ' + x);
      return new Dec(BigInt(x) * ONE);
    }
    const s = x.trim();
    const m = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(s);
    if (!m) throw new TypeError(`invalid decimal: "${x}"`);
    const frac = (m[3] ?? '');
    if (frac.length > SCALE) throw new RangeError(`too many fractional digits (max ${SCALE}): ${x}`);
    const v = BigInt(m[2]) * ONE + BigInt((frac + '0'.repeat(SCALE)).slice(0, SCALE) || '0');
    return new Dec(m[1] === '-' ? -v : v);
  }
  static isValid(x: string): boolean { try { Dec.of(x); return true; } catch { return false; } }
  static zero(): Dec { return new Dec(0n); }

  add(o: Dec | string | number): Dec { return new Dec(this.v + Dec.of(o).v); }
  sub(o: Dec | string | number): Dec { return new Dec(this.v - Dec.of(o).v); }
  mul(o: Dec | string | number): Dec { return new Dec(roundDiv(this.v * Dec.of(o).v, ONE)); }
  div(o: Dec | string | number): Dec {
    const d = Dec.of(o).v;
    if (d === 0n) throw new RangeError('division by zero');
    return new Dec(roundDiv(this.v * ONE, d));
  }
  neg(): Dec { return new Dec(-this.v); }
  abs(): Dec { return this.v < 0n ? this.neg() : this; }
  cmp(o: Dec | string | number): -1 | 0 | 1 { const b = Dec.of(o).v; return this.v < b ? -1 : this.v > b ? 1 : 0; }
  eq(o: Dec | string | number) { return this.cmp(o) === 0; }
  lt(o: Dec | string | number) { return this.cmp(o) < 0; }
  lte(o: Dec | string | number) { return this.cmp(o) <= 0; }
  gt(o: Dec | string | number) { return this.cmp(o) > 0; }
  gte(o: Dec | string | number) { return this.cmp(o) >= 0; }
  isZero() { return this.v === 0n; }
  isNeg() { return this.v < 0n; }
  static min(a: Dec, b: Dec): Dec { return a.lte(b) ? a : b; }
  static max(a: Dec, b: Dec): Dec { return a.gte(b) ? a : b; }
  static sum(xs: (Dec | string)[]): Dec { return xs.reduce<Dec>((acc, x) => acc.add(x), Dec.zero()); }

  /** Rounds half away from zero to `dp` decimal places. */
  round(dp: number): Dec {
    const f = 10n ** BigInt(SCALE - dp);
    return new Dec(roundDiv(this.v, f) * f);
  }
  /** Rounds UP (away from zero) — used for material requirements so we never under-plan. */
  ceil(dp: number): Dec {
    const f = 10n ** BigInt(SCALE - dp);
    const q = this.v / f; const r = this.v % f;
    return new Dec((r === 0n ? q : this.v > 0n ? q + 1n : q - 1n) * f);
  }
  toFixed(dp: number): string {
    const r = this.round(dp).v;
    const neg = r < 0n; const a = neg ? -r : r;
    const int = a / ONE; const frac = (a % ONE).toString().padStart(SCALE, '0').slice(0, dp);
    return (neg ? '-' : '') + int.toString() + (dp > 0 ? '.' + frac : '');
  }
  /** Canonical string without trailing zeros. */
  toString(): string {
    const s = this.toFixed(SCALE);
    return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
  }
  toJSON(): string { return this.toString(); }
}

function roundDiv(n: bigint, d: bigint): bigint {
  const neg = (n < 0n) !== (d < 0n);
  const an = n < 0n ? -n : n; const ad = d < 0n ? -d : d;
  let q = an / ad; const r = an % ad;
  if (r * 2n >= ad) q += 1n;
  return neg ? -q : q;
}

export const dec = Dec.of;
