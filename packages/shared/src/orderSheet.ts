/**
 * Order / cutting sheet import ("fotoğraftan sipariş").
 * The AI only transcribes what is written on the sheet. Everything that decides what goes into
 * the system — totals, duplicates, size splits, matching — is deterministic code in this file and
 * on the server, and the user confirms the result before any record is created.
 */
import { z } from 'zod/v4';
import type { OrderSheetExtractionData } from './orderSheetCore.ts';
export * from './orderSheetCore.ts';

const str = z.string().trim().max(300);
const optStr = str.nullable().optional().transform((v) => (v ? v : null));
const isoOrNull = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().catch(null).transform((v) => v ?? null);

export const SECTION_KINDS = ['requested', 'ordered', 'cut', 'other'] as const;

/** Shape the AI must return (validated server-side; anything else is rejected, not repaired). */
export const OrderSheetExtraction = z.object({
  customer: optStr,
  partyNo: optStr,
  modelCode: optStr,
  modelName: optStr,
  productType: optStr,
  fabric: optStr,
  composition: optStr,
  labelBrand: optStr,
  cuttingDate: isoOrNull,
  dueDate: isoOrNull,
  workshop: optStr,
  notes: z.array(str).max(30).default([]),
  decorations: z.array(str).max(30).default([]),
  sizes: z.array(z.object({ size: str.min(1), ratio: z.number().nonnegative().nullable().optional().transform((v) => v ?? null) })).max(20).default([]),
  sections: z.array(z.object({
    title: str,
    kind: z.enum(SECTION_KINDS).catch('other'),
    printedTotal: z.number().int().nonnegative().nullable().optional().transform((v) => v ?? null),
    lines: z.array(z.object({
      color: str.min(1),
      size: optStr,
      quantity: z.number().int().nonnegative(),
      uncertain: z.boolean().optional().default(false),
    })).max(300),
  })).max(10).default([]),
  measurements: z.array(z.object({ name: str, values: z.array(z.object({ size: str, value: z.number() })).max(20) })).max(30).default([]),
  uncertainties: z.array(str).max(30).default([]),
});
export type OrderSheetExtraction = z.infer<typeof OrderSheetExtraction>;
// the schema output must stay assignable to the dependency-free type used by the web app
const _shapeCheck = (x: OrderSheetExtraction): OrderSheetExtractionData => x; void _shapeCheck;

export const ExtractOrderSheetReq = z.object({
  mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  /** base64 without data: prefix; ~6 MB decoded at most */
  imageBase64: z.string().min(100).max(8_000_000).regex(/^[A-Za-z0-9+/]+=*$/, 'base64 olmalı'),
});

export const ParseOrderSheetReq = z.object({ text: z.string().min(2).max(200_000) });

export const CreateColorReq = z.object({ code: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9._\-]+$/), name: z.string().trim().min(1).max(80) });
export const CreateSizeReq = z.object({ code: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9._\-/]+$/) });

