import { Dec } from './decimal.ts';

export type UnitCode = 'PCS' | 'M' | 'CM' | 'YD' | 'KG' | 'G' | 'ROLL' | 'CARTON' | 'M2';
export const UNIT_DIMENSION: Record<UnitCode, 'COUNT' | 'LENGTH' | 'MASS' | 'AREA' | 'PACK'> = {
  PCS: 'COUNT', ROLL: 'COUNT', M: 'LENGTH', CM: 'LENGTH', YD: 'LENGTH', KG: 'MASS', G: 'MASS', M2: 'AREA', CARTON: 'PACK',
};

/** Exact same-dimension factors to the dimension's base (M, KG). Mirrors the unit_conversion table. */
const TO_BASE: Partial<Record<UnitCode, string>> = { M: '1', CM: '0.01', YD: '0.9144', KG: '1', G: '0.001' };

export class UnitConversionError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'UnitConversionError'; }
}

/** Same-dimension conversion only (m<->yd, kg<->g). Count units never convert implicitly. */
export function convertSameDimension(qty: Dec, from: UnitCode, to: UnitCode): Dec {
  if (from === to) return qty;
  if (UNIT_DIMENSION[from] !== UNIT_DIMENSION[to] || !TO_BASE[from] || !TO_BASE[to]) {
    throw new UnitConversionError('UNIT_CONVERSION_NOT_ALLOWED', `cannot convert ${from} to ${to} without additional physical data`);
  }
  return qty.mul(TO_BASE[from]!).div(TO_BASE[to]!);
}

export interface FabricGeometry { gsm?: string | null; widthCm?: string | null }

/**
 * Converts fabric mass to length using: meters = kg * 1000 / (GSM * width_m).
 * Refuses to guess: both GSM and full width must be known and positive. The result is an
 * estimate whose basis is returned so it can be stored next to the quantity.
 */
export function kgToMeters(kg: Dec, g: FabricGeometry): { meters: Dec; basis: Record<string, string> } {
  if (!g.gsm || !g.widthCm || !Dec.of(g.gsm).gt(0) || !Dec.of(g.widthCm).gt(0)) {
    throw new UnitConversionError('FABRIC_GEOMETRY_REQUIRED', 'kg↔m conversion requires GSM and width');
  }
  const widthM = Dec.of(g.widthCm).div(100);
  const meters = kg.mul(1000).div(Dec.of(g.gsm).mul(widthM));
  return { meters, basis: { method: 'GSM_WIDTH', formula: 'm = kg*1000/(gsm*width_m)', gsm: g.gsm, widthCm: g.widthCm } };
}

export function metersToKg(m: Dec, g: FabricGeometry): { kg: Dec; basis: Record<string, string> } {
  if (!g.gsm || !g.widthCm || !Dec.of(g.gsm).gt(0) || !Dec.of(g.widthCm).gt(0)) {
    throw new UnitConversionError('FABRIC_GEOMETRY_REQUIRED', 'kg↔m conversion requires GSM and width');
  }
  const kg = m.mul(Dec.of(g.gsm)).mul(Dec.of(g.widthCm).div(100)).div(1000);
  return { kg, basis: { method: 'GSM_WIDTH', formula: 'kg = m*gsm*width_m/1000', gsm: g.gsm, widthCm: g.widthCm } };
}

/**
 * Resolves a received quantity into the material's base unit.
 * - same unit: as-is
 * - same dimension: exact factor
 * - KG <-> M: only when the caller explicitly allows the GSM/width estimate
 */
export function toBaseUnit(qty: Dec, from: UnitCode, base: UnitCode, opts: { allowGsmWidthEstimate?: boolean; geometry?: FabricGeometry } = {}): { qty: Dec; basis: Record<string, string> } {
  if (from === base) return { qty, basis: { method: 'MEASURED', unit: base } };
  if (UNIT_DIMENSION[from] === UNIT_DIMENSION[base]) return { qty: convertSameDimension(qty, from, base), basis: { method: 'EXACT_FACTOR', from, to: base } };
  const pair = `${UNIT_DIMENSION[from]}>${UNIT_DIMENSION[base]}`;
  if (pair === 'MASS>LENGTH' || pair === 'LENGTH>MASS') {
    if (!opts.allowGsmWidthEstimate) throw new UnitConversionError('UNIT_CONVERSION_NOT_ALLOWED', `${from}→${base} needs explicit GSM/width estimate approval`);
    const inKgOrM = convertSameDimension(qty, from, UNIT_DIMENSION[from] === 'MASS' ? 'KG' : 'M');
    if (pair === 'MASS>LENGTH') { const r = kgToMeters(inKgOrM, opts.geometry ?? {}); return { qty: convertSameDimension(r.meters, 'M', base), basis: { ...r.basis, from } }; }
    const r = metersToKg(inKgOrM, opts.geometry ?? {}); return { qty: convertSameDimension(r.kg, 'KG', base), basis: { ...r.basis, from } };
  }
  throw new UnitConversionError('UNIT_CONVERSION_NOT_ALLOWED', `cannot convert ${from} to ${base}`);
}
