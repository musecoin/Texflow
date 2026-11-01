/** Zod request/response contracts shared by API and web client. */
import { z } from 'zod/v4';
import { Dec } from './decimal.ts';

/** Decimal transported as a string, e.g. "125.5". Rejects floats-as-numbers and >scale digits. */
export const decimalStr = (opts: { positive?: boolean; nonNegative?: boolean; maxDp?: number } = {}) =>
  z.string().trim().refine((s) => /^-?\d+(\.\d+)?$/.test(s) && (s.split('.')[1]?.length ?? 0) <= (opts.maxDp ?? 4), { message: `geçerli bir ondalık sayı olmalı (en fazla ${opts.maxDp ?? 4} basamak)` })
    .refine((s) => !opts.positive || Dec.of(s).gt(0), { message: 'sıfırdan büyük olmalı' })
    .refine((s) => !opts.nonNegative || !Dec.of(s).isNeg(), { message: 'negatif olamaz' });

export const uuid = z.string().uuid();
export const code = z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9._\-/]+$/, 'yalnızca harf, rakam ve . _ - /');
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-AA-GG');
export const unitCode = z.enum(['PCS', 'M', 'CM', 'YD', 'KG', 'G', 'ROLL', 'CARTON', 'M2']);

export const LoginReq = z.object({ organizationCode: code, email: z.string().trim().email().max(200), password: z.string().min(1).max(200) });
export const RefreshReq = z.object({ refreshToken: z.string().min(20).max(200) });

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  q: z.string().trim().max(100).optional(),
  status: z.string().trim().max(40).optional(),
  sort: z.string().trim().max(40).optional(),
});

export const CreateCustomerReq = z.object({ code, name: z.string().trim().min(1).max(200), country: z.string().length(2).optional(), currency: z.string().length(3) });

export const CreateSalesOrderReq = z.object({
  factoryId: uuid,
  customerId: uuid,
  customerPo: z.string().trim().max(60).optional(),
  currency: z.string().length(3),
  orderDate: isoDate,
  dueDate: isoDate,
  notes: z.string().max(2000).optional(),
  lines: z.array(z.object({
    modelId: uuid, colorId: uuid, sizeId: uuid,
    quantity: decimalStr({ positive: true, maxDp: 0 }),
    unitPrice: decimalStr({ nonNegative: true }),
  })).min(1).max(500),
}).refine((o) => o.dueDate >= o.orderDate, { message: 'termin tarihi sipariş tarihinden önce olamaz', path: ['dueDate'] });

export const TransitionReq = z.object({ expectedVersion: z.number().int().positive(), reason: z.string().max(500).optional() });

export const CreateModelReq = z.object({
  code, name: z.string().trim().min(1).max(200), customerId: uuid.optional(), season: z.string().max(40).optional(),
  productType: z.string().max(60).optional(),
  colorIds: z.array(uuid).min(1).max(50), sizeIds: z.array(uuid).min(1).max(50),
});

export const CreateBomReq = z.object({
  notes: z.string().max(2000).optional(),
  items: z.array(z.object({
    materialId: uuid, colorId: uuid.optional(), placement: z.string().max(100).optional(),
    consumptionPerPiece: decimalStr({ positive: true, maxDp: 6 }), unit: unitCode,
    wastePct: decimalStr({ nonNegative: true, maxDp: 4 }).default('0'),
  })).min(1).max(200),
});

export const CreateMaterialReq = z.object({
  code, name: z.string().trim().min(1).max(200),
  kind: z.enum(['FABRIC', 'TRIM', 'THREAD', 'PACKAGING', 'DECORATION_CONSUMABLE']),
  baseUnit: unitCode, widthCm: decimalStr({ positive: true, maxDp: 2 }).optional(), gsm: decimalStr({ positive: true, maxDp: 2 }).optional(),
  composition: z.string().max(200).optional(), defaultSupplierId: uuid.optional(), inspectionPlanId: uuid.optional(),
});

export const ReceiveRollsReq = z.object({
  factoryId: uuid, supplierId: uuid, warehouseId: uuid, binId: uuid.optional(),
  supplierDeliveryNote: z.string().max(60).optional(),
  rolls: z.array(z.object({
    materialId: uuid, lotNo: z.string().trim().min(1).max(60), dyeLot: z.string().max(60).optional(),
    supplierRollNo: z.string().max(60).optional(), colorId: uuid.optional(), shade: z.string().trim().min(1).max(20),
    widthCm: decimalStr({ positive: true, maxDp: 2 }).optional(), gsm: decimalStr({ positive: true, maxDp: 2 }).optional(),
    grossWeightKg: decimalStr({ nonNegative: true }).optional(), netWeightKg: decimalStr({ nonNegative: true }).optional(),
    lengthM: decimalStr({ nonNegative: true }).optional(),
    quantity: decimalStr({ positive: true }), unit: unitCode,
    allowGsmWidthEstimate: z.boolean().default(false),
  })).min(1).max(200),
});

export const InspectRollReq = z.object({
  inspectedLengthM: decimalStr({ positive: true }), cuttableWidthCm: decimalStr({ positive: true, maxDp: 2 }),
  measuredGsm: decimalStr({ positive: true, maxDp: 2 }).optional(), measuredWidthCm: decimalStr({ positive: true, maxDp: 2 }).optional(),
  shrinkageLengthPct: decimalStr({ maxDp: 3 }).optional(), shrinkageWidthPct: decimalStr({ maxDp: 3 }).optional(),
  shadeResult: z.enum(['MATCH', 'MINOR_VARIATION', 'REJECT']).optional(),
  defects: z.array(z.object({
    code: code, lengthIn: decimalStr({ positive: true, maxDp: 2 }).optional(), isHole: z.boolean().default(false),
    positionM: decimalStr({ nonNegative: true }).optional(),
  }).refine((d) => d.isHole || d.lengthIn, { message: 'delik değilse uzunluk zorunlu' })).max(500),
  notes: z.string().max(2000).optional(),
  expectedVersion: z.number().int().positive(),
});

export const CreateWorkOrderReq = z.object({
  salesOrderId: uuid, modelId: uuid, colorId: uuid, plannedQty: decimalStr({ positive: true, maxDp: 0 }),
  plannedStart: isoDate.optional(), plannedEnd: isoDate.optional(),
});

export const ReserveReq = z.object({
  policy: z.enum(['FIFO']).default('FIFO'),
  allowPartial: z.boolean().default(true),
  singleShade: z.boolean().default(true),
  /** optional explicit roll (e.g. scanned QR); otherwise automatic allocation */
  rollId: uuid.optional(),
  qty: decimalStr({ positive: true }).optional(),
});

export const AdjustmentReq = z.object({ rollId: uuid, qtyDelta: decimalStr(), reason: z.string().trim().min(5).max(500) });
export const DecisionReq = z.object({ approve: z.boolean(), note: z.string().max(500).optional() });

export type CreateSalesOrderInput = z.infer<typeof CreateSalesOrderReq>;
export type ReceiveRollsInput = z.infer<typeof ReceiveRollsReq>;
export type InspectRollInput = z.infer<typeof InspectRollReq>;
