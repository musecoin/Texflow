import { Dec } from './decimal.ts';

/**
 * Gross material requirement for one BOM line:
 *   required = planned_qty × consumption_per_piece × (1 + waste_pct/100), rounded UP to 4 dp.
 * Rounding up guarantees the plan never under-covers by a rounding artifact.
 */
export function materialRequirement(plannedQty: string, consumptionPerPiece: string, wastePct: string): Dec {
  return Dec.of(plannedQty).mul(consumptionPerPiece).mul(Dec.of(1).add(Dec.of(wastePct).div(100))).ceil(4);
}

export interface AllocatableRoll { id: string; lotId: string; shade: string; colorId: string | null; receivedAt: string; available: string; /** receipt sequence (roll number) — FIFO tie-breaker */ seq?: string }
const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

export interface AllocationLine { rollId: string; qty: Dec; lotId: string; shade: string }

/**
 * FIFO allocation with shade/lot restriction.
 * - candidates must already be ACCEPTED, same material, ordered by the caller-agnostic rule here
 * - if shadeLock/lotLock are set, only matching rolls qualify
 * - with `singleShade`, the first roll picked fixes the shade for the rest of the allocation
 * Returns the lines and the uncovered shortfall (never negative).
 */
export function allocateFifo(args: {
  rolls: AllocatableRoll[]; needed: Dec; colorId?: string | null;
  shadeLock?: string | null; lotLock?: string | null; singleShade?: boolean; singleLot?: boolean;
}): { lines: AllocationLine[]; shortfall: Dec; shade: string | null; lotId: string | null } {
  let shade = args.shadeLock ?? null; let lot = args.lotLock ?? null;
  const pool = [...args.rolls]
    .filter((r) => Dec.of(r.available).gt(0))
    .filter((r) => !args.colorId || r.colorId === args.colorId)
    .sort((a, b) => cmp(a.receivedAt, b.receivedAt) || cmp(a.seq ?? '', b.seq ?? '') || cmp(a.id, b.id));
  let remaining = args.needed;
  const lines: AllocationLine[] = [];
  for (const r of pool) {
    if (!remaining.gt(0)) break;
    if (shade && r.shade !== shade) continue;
    if (lot && r.lotId !== lot) continue;
    const take = Dec.min(remaining, Dec.of(r.available));
    lines.push({ rollId: r.id, qty: take, lotId: r.lotId, shade: r.shade });
    remaining = remaining.sub(take);
    if (args.singleShade !== false && !shade) shade = r.shade;
    if (args.singleLot && !lot) lot = r.lotId;
  }
  return { lines, shortfall: Dec.max(remaining, Dec.zero()), shade, lotId: lot };
}
