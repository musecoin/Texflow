/**
 * Explicit state machines. Each transition names the permission required to perform it.
 * `system` transitions are only performed by server-side workflows (never directly by a user call).
 */
export interface Transition<S extends string> { from: S; to: S; action: string; permission: string | 'system' }

export type SalesOrderStatus = 'DRAFT' | 'CONFIRMED' | 'IN_PRODUCTION' | 'COMPLETED' | 'SHIPPED' | 'CANCELLED';
export const SALES_ORDER_TRANSITIONS: Transition<SalesOrderStatus>[] = [
  { from: 'DRAFT', to: 'CONFIRMED', action: 'confirm', permission: 'order.confirm' },
  { from: 'DRAFT', to: 'CANCELLED', action: 'cancel', permission: 'order.cancel' },
  { from: 'CONFIRMED', to: 'CANCELLED', action: 'cancel', permission: 'order.cancel' },
  { from: 'CONFIRMED', to: 'IN_PRODUCTION', action: 'start_production', permission: 'system' },
  { from: 'IN_PRODUCTION', to: 'COMPLETED', action: 'complete', permission: 'system' },
  { from: 'COMPLETED', to: 'SHIPPED', action: 'ship', permission: 'system' },
];

export type ModelStatus = 'DRAFT' | 'IN_REVIEW' | 'TECH_APPROVED' | 'ARCHIVED';
export const MODEL_TRANSITIONS: Transition<ModelStatus>[] = [
  { from: 'DRAFT', to: 'IN_REVIEW', action: 'submit', permission: 'model.write' },
  { from: 'IN_REVIEW', to: 'TECH_APPROVED', action: 'approve', permission: 'model.approve' },
  { from: 'IN_REVIEW', to: 'DRAFT', action: 'reject', permission: 'model.approve' },
  { from: 'TECH_APPROVED', to: 'ARCHIVED', action: 'archive', permission: 'model.approve' },
];

export type BomStatus = 'DRAFT' | 'APPROVED' | 'OBSOLETE';
export const BOM_TRANSITIONS: Transition<BomStatus>[] = [
  { from: 'DRAFT', to: 'APPROVED', action: 'approve', permission: 'bom.approve' },
  { from: 'APPROVED', to: 'OBSOLETE', action: 'obsolete', permission: 'system' },
];

export type WorkOrderStatus = 'PLANNED' | 'RELEASED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
export const WORK_ORDER_TRANSITIONS: Transition<WorkOrderStatus>[] = [
  { from: 'PLANNED', to: 'RELEASED', action: 'release', permission: 'workorder.release' },
  { from: 'PLANNED', to: 'CANCELLED', action: 'cancel', permission: 'workorder.release' },
  { from: 'RELEASED', to: 'IN_PROGRESS', action: 'start', permission: 'system' },
  { from: 'IN_PROGRESS', to: 'COMPLETED', action: 'complete', permission: 'system' },
];

export type RollQualityStatus = 'QUARANTINE' | 'ACCEPTED' | 'REJECTED';
export const ROLL_TRANSITIONS: Transition<RollQualityStatus>[] = [
  { from: 'QUARANTINE', to: 'ACCEPTED', action: 'inspect_pass', permission: 'inventory.inspect' },
  { from: 'QUARANTINE', to: 'REJECTED', action: 'inspect_fail', permission: 'inventory.inspect' },
];

export class TransitionError extends Error {
  code = 'INVALID_TRANSITION';
  from: string; action: string;
  constructor(entity: string, from: string, action: string) {
    super(`${entity}: '${action}' is not allowed from status ${from}`);
    this.from = from; this.action = action;
  }
}

export function findTransition<S extends string>(table: Transition<S>[], entity: string, from: S, action: string): Transition<S> {
  const t = table.find((x) => x.from === from && x.action === action);
  if (!t) throw new TransitionError(entity, from, action);
  return t;
}

export function allowedActions<S extends string>(table: Transition<S>[], from: S): string[] {
  return table.filter((t) => t.from === from && t.permission !== 'system').map((t) => t.action);
}
