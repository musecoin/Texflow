import { Dec } from './decimal.ts';

/**
 * ASTM D5430-style 4-point fabric inspection.
 * Defect points by defect length (inches): <=3 → 1, >3..6 → 2, >6..9 → 3, >9 → 4; holes/openings → 4.
 * No more than 4 points are assigned per linear yard of fabric (the standard's per-yard cap);
 * callers group defects by yard via positionM.
 * Points per 100 sq yd = total points × 3600 / (inspected yards × cuttable width inches).
 * Acceptance limits are NOT defined here: they come from the configured inspection plan.
 */
export interface DefectInput { code: string; lengthIn?: string | null; isHole?: boolean; positionM?: string | null }

export function defectPoints(d: DefectInput): 1 | 2 | 3 | 4 {
  if (d.isHole) return 4;
  if (d.lengthIn == null) throw new RangeError(`defect ${d.code}: length is required unless it is a hole`);
  const l = Dec.of(d.lengthIn);
  if (l.lte(0)) throw new RangeError(`defect ${d.code}: length must be positive`);
  if (l.lte(3)) return 1;
  if (l.lte(6)) return 2;
  if (l.lte(9)) return 3;
  return 4;
}

const M_PER_YD = '0.9144';
const CM_PER_IN = '2.54';

export function scoreFourPoint(input: { inspectedLengthM: string; cuttableWidthCm: string; defects: DefectInput[] }) {
  const yards = Dec.of(input.inspectedLengthM).div(M_PER_YD);
  const widthIn = Dec.of(input.cuttableWidthCm).div(CM_PER_IN);
  if (!yards.gt(0) || !widthIn.gt(0)) throw new RangeError('inspected length and cuttable width must be positive');
  const perYard = new Map<string, number>();
  const scored = input.defects.map((d) => {
    const raw = defectPoints(d);
    // cap at 4 points per linear yard when position is known
    let pts: number = raw;
    if (d.positionM != null) {
      const yardIdx = Dec.of(d.positionM).div(M_PER_YD).toFixed(10).split('.')[0];
      const used = perYard.get(yardIdx) ?? 0;
      pts = Math.max(0, Math.min(raw, 4 - used));
      perYard.set(yardIdx, used + pts);
    }
    return { ...d, rawPoints: raw, points: pts };
  });
  const total = scored.reduce((a, d) => a + d.points, 0);
  const per100 = Dec.of(total).mul(3600).div(yards.mul(widthIn));
  return { totalPoints: total, pointsPer100SqYd: per100.round(4), defects: scored };
}

export interface InspectionPlan {
  maxPointsPer100SqYd: string;
  maxWidthDeviationPct?: string | null;
  maxGsmDeviationPct?: string | null;
  maxShrinkagePct?: string | null;
}

export function evaluateInspection(args: {
  plan: InspectionPlan;
  pointsPer100SqYd: Dec;
  nominalWidthCm?: string | null; measuredWidthCm?: string | null;
  nominalGsm?: string | null; measuredGsm?: string | null;
  shrinkageLengthPct?: string | null; shrinkageWidthPct?: string | null;
  shadeResult?: 'MATCH' | 'MINOR_VARIATION' | 'REJECT' | null;
}): { result: 'PASS' | 'FAIL'; failedChecks: string[] } {
  const failed: string[] = [];
  const p = args.plan;
  if (args.pointsPer100SqYd.gt(p.maxPointsPer100SqYd)) failed.push('POINTS');
  const dev = (nom?: string | null, meas?: string | null) => (nom && meas ? Dec.of(meas).sub(nom).abs().div(nom).mul(100) : null);
  const wd = dev(args.nominalWidthCm, args.measuredWidthCm);
  if (p.maxWidthDeviationPct && wd && wd.gt(p.maxWidthDeviationPct)) failed.push('WIDTH');
  const gd = dev(args.nominalGsm, args.measuredGsm);
  if (p.maxGsmDeviationPct && gd && gd.gt(p.maxGsmDeviationPct)) failed.push('GSM');
  for (const [k, v] of [['SHRINKAGE_LENGTH', args.shrinkageLengthPct], ['SHRINKAGE_WIDTH', args.shrinkageWidthPct]] as const) {
    if (p.maxShrinkagePct && v != null && Dec.of(v).abs().gt(p.maxShrinkagePct)) failed.push(k);
  }
  if (args.shadeResult === 'REJECT') failed.push('SHADE');
  return { result: failed.length ? 'FAIL' : 'PASS', failedChecks: failed };
}
